"""개인 API 키를 운영체제 자격 정보 저장소나 안전한 파일에 보관한다."""

import os
import stat
from pathlib import Path
from typing import Any

SERVICE_NAME = "essay-grader"
ACCOUNT_NAME = "gemini-api-key"


class CredentialStore:
    def __init__(self, fallback_path: Path, keyring_module: Any | None = None) -> None:
        if keyring_module is None:
            import keyring as keyring_module

        self._keyring = keyring_module
        self._fallback_path = fallback_path

    def set_api_key(self, api_key: str) -> None:
        cleaned = api_key.strip()
        if not cleaned:
            raise ValueError("API 키가 비어 있습니다.")

        try:
            self._keyring.set_password(SERVICE_NAME, ACCOUNT_NAME, cleaned)
        except Exception:
            self._write_fallback(cleaned)
        else:
            self._fallback_path.unlink(missing_ok=True)

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
        except Exception:
            pass
        self._fallback_path.unlink(missing_ok=True)

    def _read_fallback(self) -> str | None:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(self._fallback_path, flags)
        except FileNotFoundError:
            return None

        with os.fdopen(descriptor, encoding="utf-8") as handle:
            file_stat = os.fstat(handle.fileno())
            if not stat.S_ISREG(file_stat.st_mode):
                raise PermissionError("API 키 대체 경로가 일반 파일이 아닙니다.")
            if stat.S_IMODE(file_stat.st_mode) != 0o600:
                raise PermissionError("API 키 대체 파일 권한이 안전하지 않습니다.")
            return handle.read().strip() or None

    def _write_fallback(self, value: str) -> None:
        self._fallback_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self._fallback_path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(value)
