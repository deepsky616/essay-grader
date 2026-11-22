import os

import pytest
from cryptography.fernet import Fernet

from app.providers import credentials as credentials_module
from app.providers.credentials import CredentialStore
from tests.fakes import FakeKeyring


def test_saves_and_reads_key_from_keyring(tmp_path):
    store = CredentialStore(fallback_path=tmp_path / "key", keyring_module=FakeKeyring())
    store.set_api_key("api-key-secret")

    assert store.get_api_key() == "api-key-secret"


def test_fallback_is_authenticated_encrypted_and_does_not_contain_plaintext(tmp_path):
    fallback = tmp_path / "key"
    encryption_key = Fernet.generate_key()
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=encryption_key,
    )
    store.set_api_key("api-key-secret")

    assert store.get_api_key() == "api-key-secret"
    assert b"api-key-secret" not in fallback.read_bytes()


def test_fallback_without_encryption_key_refuses_storage_without_creating_file(
    tmp_path,
):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback, FakeKeyring(working=False))

    with pytest.raises(RuntimeError):
        store.set_api_key("api-key-secret")

    assert not fallback.exists()


def test_wrong_encryption_key_is_rejected(tmp_path):
    fallback = tmp_path / "key"
    writer = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )
    writer.set_api_key("api-key-secret")
    reader = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )

    with pytest.raises(RuntimeError):
        reader.get_api_key()


def test_tampered_ciphertext_is_rejected(tmp_path):
    fallback = tmp_path / "key"
    encryption_key = Fernet.generate_key()
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=encryption_key,
    )
    store.set_api_key("api-key-secret")
    ciphertext = bytearray(fallback.read_bytes())
    ciphertext[-1] ^= 1
    fallback.write_bytes(ciphertext)
    os.chmod(fallback, 0o600)

    with pytest.raises(RuntimeError):
        store.get_api_key()


def test_fallback_file_is_owner_only(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )

    store.set_api_key("api-key-secret")

    assert fallback.stat().st_mode & 0o777 == 0o600


def test_missing_key_returns_none(tmp_path):
    store = CredentialStore(tmp_path / "key", FakeKeyring())

    assert store.get_api_key() is None


def test_clear_removes_key(tmp_path):
    fallback = tmp_path / "key"
    encryption_key = Fernet.generate_key()
    writer = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=encryption_key,
    )
    writer.set_api_key("api-key-secret")

    class MissingKeyring:
        def delete_password(self, service, name):
            raise RuntimeError("missing backend")

        def get_password(self, service, name):
            return None

    store = CredentialStore(fallback, MissingKeyring(), encryption_key)
    store.clear_api_key()

    assert store.get_api_key() is None
    assert not fallback.exists()


def test_empty_key_is_rejected(tmp_path):
    store = CredentialStore(tmp_path / "key", FakeKeyring())

    with pytest.raises(ValueError):
        store.set_api_key("   ")


def test_keyring_success_removes_stale_fallback(tmp_path):
    fallback = tmp_path / "key"
    encryption_key = Fernet.generate_key()
    failed_store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=encryption_key,
    )
    failed_store.set_api_key("stale-secret")
    store = CredentialStore(fallback, FakeKeyring())

    store.set_api_key("fresh-secret")

    assert not fallback.exists()
    assert store.get_api_key() == "fresh-secret"


def test_delete_failure_is_not_reported_as_success_and_key_recovers(tmp_path):
    keyring = FakeKeyring()
    store = CredentialStore(tmp_path / "key", keyring)
    store.set_api_key("api-key-secret")
    keyring._working = False

    with pytest.raises(RuntimeError):
        store.clear_api_key()

    keyring._working = True
    assert store.get_api_key() == "api-key-secret"


def test_symbolic_link_fallback_is_rejected_without_changing_target(tmp_path):
    target = tmp_path / "target"
    target.write_bytes(b"keep-me")
    os.chmod(target, 0o600)
    fallback = tmp_path / "key"
    fallback.symlink_to(target)
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )

    with pytest.raises(RuntimeError):
        store.set_api_key("api-key-secret")

    assert target.read_bytes() == b"keep-me"


def test_wide_permission_fallback_is_rejected(tmp_path):
    fallback = tmp_path / "key"
    fallback.write_bytes(b"not-safe")
    os.chmod(fallback, 0o644)
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )

    with pytest.raises(RuntimeError):
        store.get_api_key()


def test_non_regular_fallback_is_rejected(tmp_path):
    fallback = tmp_path / "key"
    fallback.mkdir()
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )

    with pytest.raises(RuntimeError):
        store.set_api_key("api-key-secret")


def test_missing_no_follow_support_refuses_fallback_write(tmp_path, monkeypatch):
    fallback = tmp_path / "key"
    monkeypatch.setattr(credentials_module.os, "O_NOFOLLOW", 0)
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=Fernet.generate_key(),
    )

    with pytest.raises(RuntimeError):
        store.set_api_key("api-key-secret")

    assert not fallback.exists()


def test_atomic_replace_failure_preserves_old_ciphertext_and_cleans_temp(
    tmp_path, monkeypatch
):
    fallback = tmp_path / "key"
    encryption_key = Fernet.generate_key()
    store = CredentialStore(
        fallback,
        FakeKeyring(working=False),
        fallback_encryption_key=encryption_key,
    )
    store.set_api_key("old-secret")
    old_ciphertext = fallback.read_bytes()

    def fail_replace(source, destination):
        raise OSError("replace failed")

    monkeypatch.setattr(credentials_module.os, "replace", fail_replace)

    with pytest.raises(RuntimeError):
        store.set_api_key("new-secret")

    assert fallback.read_bytes() == old_ciphertext
    assert list(tmp_path.glob(".key.*.tmp")) == []
