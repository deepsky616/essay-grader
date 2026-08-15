import json

import pytest

from app.api import settings as settings_api
from app.providers.credentials import CredentialStore
from tests.fakes import FakeKeyring, FakeLLMProvider


@pytest.fixture(autouse=True)
def stub_external_dependencies(client, tmp_path, monkeypatch):
    """실제 자격 정보 저장소와 외부 제공자를 사용하지 않는다."""
    store = CredentialStore(tmp_path / "credential", FakeKeyring())
    client.app.dependency_overrides[settings_api.get_credential_store] = lambda: store
    monkeypatch.setattr(
        settings_api,
        "build_provider",
        lambda api_key, model: FakeLLMProvider(
            responses=[],
            models=["models/gemini-pro", "models/gemini-flash"],
        ),
    )
    yield
    client.app.dependency_overrides.clear()


def test_settings_start_empty(client):
    body = client.get("/api/settings").json()

    assert body == {
        "api_key_set": False,
        "llm_model": None,
        "data_policy_acknowledged": False,
    }


def test_save_api_key_marks_it_set_without_returning_it(client):
    response = client.put(
        "/api/settings/api-key", json={"api_key": "api-key-secret"}
    )

    assert response.status_code == 200
    assert client.get("/api/settings").json()["api_key_set"] is True
    assert "api-key-secret" not in response.text


def test_empty_api_key_is_rejected_without_echoing_input(client):
    response = client.put("/api/settings/api-key", json={"api_key": "   "})

    assert response.status_code == 400
    assert "api_key" not in response.text


def test_invalid_api_key_shape_is_rejected_without_echoing_secret(client):
    response = client.put(
        "/api/settings/api-key", json={"api_key": ["api-key-secret"]}
    )

    assert response.status_code == 400
    assert "api-key-secret" not in response.text


def test_model_list_requires_api_key(client):
    assert client.get("/api/settings/models").status_code == 400


def test_model_list_returns_available_models_before_model_selection(client):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    body = client.get("/api/settings/models").json()

    assert body["models"] == ["models/gemini-pro", "models/gemini-flash"]


def test_model_list_failure_does_not_expose_provider_error_or_key(client, monkeypatch):
    class FailedProvider:
        def list_models(self):
            raise RuntimeError("request failed for api-key-secret")

    monkeypatch.setattr(
        settings_api, "build_provider", lambda api_key, model: FailedProvider()
    )
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    response = client.get("/api/settings/models")

    assert response.status_code == 400
    assert "api-key-secret" not in response.text
    assert "request failed" not in response.text


def test_select_model_persists(client):
    response = client.put(
        "/api/settings/model", json={"llm_model": "models/gemini-pro"}
    )

    assert response.status_code == 200
    assert client.get("/api/settings").json()["llm_model"] == "models/gemini-pro"


def test_empty_model_is_rejected(client):
    assert (
        client.put("/api/settings/model", json={"llm_model": "  "}).status_code
        == 400
    )


def test_data_policy_acknowledgement_persists(client):
    client.put("/api/settings/data-policy", json={"acknowledged": True})

    assert client.get("/api/settings").json()["data_policy_acknowledged"] is True


def test_clear_api_key(client):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    client.delete("/api/settings/api-key")

    assert client.get("/api/settings").json()["api_key_set"] is False


def test_api_key_is_not_stored_in_database(client, db_session):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    rows = db_session.execute(settings_api.select(settings_api.AppSetting)).scalars()

    assert "api-key-secret" not in json.dumps(
        [(row.key, row.value) for row in rows], ensure_ascii=False
    )
