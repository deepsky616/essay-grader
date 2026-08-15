import pytest

from app.providers.credentials import CredentialStore
from tests.fakes import FakeKeyring


def test_saves_and_reads_key_from_keyring(tmp_path):
    store = CredentialStore(fallback_path=tmp_path / "key", keyring_module=FakeKeyring())
    store.set_api_key("api-key-secret")

    assert store.get_api_key() == "api-key-secret"


def test_falls_back_to_file_when_keyring_unavailable(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback, FakeKeyring(working=False))
    store.set_api_key("api-key-secret")

    assert store.get_api_key() == "api-key-secret"
    assert fallback.exists()


def test_fallback_file_is_owner_only(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback, FakeKeyring(working=False))

    store.set_api_key("api-key-secret")

    assert fallback.stat().st_mode & 0o777 == 0o600


def test_missing_key_returns_none(tmp_path):
    store = CredentialStore(tmp_path / "key", FakeKeyring())

    assert store.get_api_key() is None


def test_clear_removes_key(tmp_path):
    fallback = tmp_path / "key"
    store = CredentialStore(fallback, FakeKeyring(working=False))
    store.set_api_key("api-key-secret")

    store.clear_api_key()

    assert store.get_api_key() is None
    assert not fallback.exists()


def test_empty_key_is_rejected(tmp_path):
    store = CredentialStore(tmp_path / "key", FakeKeyring())

    with pytest.raises(ValueError):
        store.set_api_key("   ")


def test_keyring_success_removes_stale_fallback(tmp_path):
    fallback = tmp_path / "key"
    failed_store = CredentialStore(fallback, FakeKeyring(working=False))
    failed_store.set_api_key("stale-secret")
    store = CredentialStore(fallback, FakeKeyring())

    store.set_api_key("fresh-secret")

    assert not fallback.exists()
    assert store.get_api_key() == "fresh-secret"
