"""개인 API 키를 운영체제 저장소나 인증 암호문으로 보관한다."""

import os
import secrets
import stat
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

SERVICE_NAME = "essay-grader"
ACCOUNT_NAME = "gemini-api-key"
_STORE_ERROR = "API 키 저장소를 안전하게 사용할 수 없습니다."
_CLEAR_ERROR = "API 키 삭제 상태를 확인할 수 없습니다."


class CredentialStoreError(RuntimeError):
    """비밀값을 포함하지 않는 자격 정보 저장 오류."""


class CredentialStore:
    def __init__(
        self,
        fallback_path: Path,
        keyring_module: Any | None = None,
        fallback_encryption_key: bytes | str | None = None,
    ) -> None:
        if keyring_module is None:
            import keyring as keyring_module

        self._keyring = keyring_module
        self._fallback_path = fallback_path
        self._fallback_encryption_key = fallback_encryption_key

    def set_api_key(self, api_key: str) -> None:
        cleaned = api_key.strip()
        if not cleaned:
            raise ValueError("API 키가 비어 있습니다.")

        try:
            self._keyring.set_password(SERVICE_NAME, ACCOUNT_NAME, cleaned)
        except Exception:
            self._write_fallback(cleaned)
        else:
            self._remove_fallback()

    def get_api_key(self) -> str | None:
        try:
            value = self._keyring.get_password(SERVICE_NAME, ACCOUNT_NAME)
            if value:
                return value
        except Exception:
            pass

        return self._read_fallback()

    def clear_api_key(self) -> None:
        try:
            self._keyring.delete_password(SERVICE_NAME, ACCOUNT_NAME)
        except Exception as delete_error:
            try:
                remaining = self._keyring.get_password(SERVICE_NAME, ACCOUNT_NAME)
            except Exception as verify_error:
                raise CredentialStoreError(_CLEAR_ERROR) from verify_error
            if remaining is not None:
                raise CredentialStoreError(_CLEAR_ERROR) from delete_error

        self._remove_fallback()

    def _fernet(self) -> Fernet:
        key = self._fallback_encryption_key
        if key is None:
            raise CredentialStoreError(_STORE_ERROR)
        if isinstance(key, str):
            try:
                key = key.encode("ascii")
            except UnicodeEncodeError as error:
                raise CredentialStoreError(_STORE_ERROR) from error
        try:
            return Fernet(key)
        except (TypeError, ValueError) as error:
            raise CredentialStoreError(_STORE_ERROR) from error

    def _read_fallback(self) -> str | None:
        path_stat = self._fallback_stat()
        if path_stat is None:
            return None
        no_follow = self._required_no_follow()
        fernet = self._fernet()

        try:
            descriptor = os.open(self._fallback_path, os.O_RDONLY | no_follow)
            with os.fdopen(descriptor, "rb") as handle:
                opened_stat = os.fstat(handle.fileno())
                self._validate_opened_file(path_stat, opened_stat)
                ciphertext = handle.read()
            return fernet.decrypt(ciphertext).decode("utf-8") or None
        except CredentialStoreError:
            raise
        except (InvalidToken, UnicodeDecodeError, OSError) as error:
            raise CredentialStoreError(_STORE_ERROR) from error

    def _write_fallback(self, value: str) -> None:
        no_follow = self._required_no_follow()
        ciphertext = self._fernet().encrypt(value.encode("utf-8"))
        self._validate_parent()
        self._fallback_stat()

        temporary_path = self._new_temporary_path()
        descriptor: int | None = None
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | no_follow
            descriptor = os.open(temporary_path, flags, 0o600)
            opened_stat = os.fstat(descriptor)
            if not stat.S_ISREG(opened_stat.st_mode):
                raise CredentialStoreError(_STORE_ERROR)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                handle.write(ciphertext)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self._fallback_path)
            temporary_path = None
            self._sync_parent_if_supported(no_follow)
        except CredentialStoreError:
            raise
        except OSError as error:
            raise CredentialStoreError(_STORE_ERROR) from error
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _fallback_stat(self) -> os.stat_result | None:
        try:
            path_stat = os.lstat(self._fallback_path)
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(path_stat.st_mode):
            raise CredentialStoreError(_STORE_ERROR)
        if stat.S_IMODE(path_stat.st_mode) != 0o600:
            raise CredentialStoreError(_STORE_ERROR)
        return path_stat

    def _validate_parent(self) -> None:
        try:
            self._fallback_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            parent_stat = os.lstat(self._fallback_path.parent)
        except OSError as error:
            raise CredentialStoreError(_STORE_ERROR) from error
        if not stat.S_ISDIR(parent_stat.st_mode):
            raise CredentialStoreError(_STORE_ERROR)

    def _validate_opened_file(
        self, expected: os.stat_result, opened: os.stat_result
    ) -> None:
        if not stat.S_ISREG(opened.st_mode):
            raise CredentialStoreError(_STORE_ERROR)
        if stat.S_IMODE(opened.st_mode) != 0o600:
            raise CredentialStoreError(_STORE_ERROR)
        if (expected.st_dev, expected.st_ino) != (opened.st_dev, opened.st_ino):
            raise CredentialStoreError(_STORE_ERROR)

    def _required_no_follow(self) -> int:
        no_follow = getattr(os, "O_NOFOLLOW", 0)
        if not no_follow:
            raise CredentialStoreError(_STORE_ERROR)
        return no_follow

    def _new_temporary_path(self) -> Path:
        for _ in range(10):
            candidate = self._fallback_path.with_name(
                f".{self._fallback_path.name}.{secrets.token_hex(8)}.tmp"
            )
            if not candidate.exists():
                return candidate
        raise CredentialStoreError(_STORE_ERROR)

    def _sync_parent_if_supported(self, no_follow: int) -> None:
        flags = os.O_RDONLY | no_follow | getattr(os, "O_DIRECTORY", 0)
        try:
            descriptor = os.open(self._fallback_path.parent, flags)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        except OSError:
            pass
        finally:
            os.close(descriptor)

    def _remove_fallback(self) -> None:
        if self._fallback_stat() is None:
            return
        try:
            self._fallback_path.unlink()
        except OSError as error:
            raise CredentialStoreError(_STORE_ERROR) from error
