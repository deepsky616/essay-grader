import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import sessionmaker

from app.api import settings as settings_api
from app.models.app_setting import AppSetting
from app.models.base import Base
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
        "data_policy_acknowledged_at": None,
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
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})
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


def test_select_model_requires_api_key(client):
    response = client.put(
        "/api/settings/model", json={"llm_model": "models/gemini-pro"}
    )

    assert response.status_code == 400
    assert client.get("/api/settings").json()["llm_model"] is None


def test_model_not_in_current_provider_list_is_rejected(client):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    response = client.put(
        "/api/settings/model", json={"llm_model": "models/not-available"}
    )

    assert response.status_code == 400
    assert client.get("/api/settings").json()["llm_model"] is None


def test_model_selection_hides_provider_failure(client, monkeypatch):
    class FailedProvider:
        def list_models(self):
            raise RuntimeError("provider exposed api-key-secret")

    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})
    monkeypatch.setattr(
        settings_api, "build_provider", lambda api_key, model: FailedProvider()
    )

    response = client.put(
        "/api/settings/model", json={"llm_model": "models/gemini-pro"}
    )

    assert response.status_code == 400
    assert "api-key-secret" not in response.text
    assert "provider exposed" not in response.text


def test_replacing_api_key_clears_previous_model_selection(client):
    client.put("/api/settings/api-key", json={"api_key": "first-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-pro"})

    client.put("/api/settings/api-key", json={"api_key": "second-secret"})

    assert client.get("/api/settings").json()["llm_model"] is None


def test_data_policy_acknowledgement_persists(client):
    response = client.put("/api/settings/data-policy", json={"acknowledged": True})

    assert client.get("/api/settings").json()["data_policy_acknowledged"] is True
    assert response.json()["data_policy_acknowledged_at"] is not None


def test_repeated_data_policy_acknowledgement_creates_new_timestamped_events(
    client, db_session
):
    first = client.put(
        "/api/settings/data-policy", json={"acknowledged": True}
    ).json()
    second = client.put(
        "/api/settings/data-policy", json={"acknowledged": True}
    ).json()

    event_model = settings_api.DataPolicyAcknowledgement
    events = list(
        db_session.scalars(select(event_model).order_by(event_model.id)).all()
    )
    assert len(events) == 2
    assert [entry.acknowledged for entry in events] == [True, True]
    assert len({entry.wording_version for entry in events}) == 1
    assert events[0].confirmed_at != events[1].confirmed_at
    assert first["data_policy_acknowledged_at"] != second[
        "data_policy_acknowledged_at"
    ]


def test_clear_api_key(client):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-pro"})

    client.delete("/api/settings/api-key")

    body = client.get("/api/settings").json()
    assert body["api_key_set"] is False
    assert body["llm_model"] is None


def test_failed_keyring_delete_returns_error_and_preserves_model(client, tmp_path):
    keyring = FakeKeyring()
    store = CredentialStore(tmp_path / "delete-failure", keyring)
    client.app.dependency_overrides[settings_api.get_credential_store] = lambda: store
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-pro"})
    keyring._working = False

    response = client.delete("/api/settings/api-key")

    assert response.status_code == 503
    assert "api-key-secret" not in response.text
    keyring._working = True
    body = client.get("/api/settings").json()
    assert body["api_key_set"] is True
    assert body["llm_model"] == "models/gemini-pro"


def test_api_key_is_not_stored_in_database(client, db_session):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    rows = db_session.execute(settings_api.select(settings_api.AppSetting)).scalars()

    assert "api-key-secret" not in json.dumps(
        [(row.key, row.value) for row in rows], ensure_ascii=False
    )


def test_first_write_of_same_setting_is_safe_under_concurrency(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'concurrent.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    workers_ready = Barrier(2)
    reads_ready = Barrier(2)

    def synchronize_old_read(connection, cursor, statement, *arguments):
        if statement.lstrip().upper().startswith("SELECT") and "app_settings" in statement:
            reads_ready.wait(timeout=5)

    event.listen(engine, "before_cursor_execute", synchronize_old_read)

    def save(value):
        workers_ready.wait(timeout=5)
        with sessions() as session:
            settings_api.write_setting(session, "shared-key", value)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(save, value) for value in ("one", "two")]
            for future in futures:
                future.result(timeout=10)
    finally:
        event.remove(engine, "before_cursor_execute", synchronize_old_read)

    with sessions() as session:
        assert session.scalar(
            select(func.count()).select_from(AppSetting).where(
                AppSetting.key == "shared-key"
            )
        ) == 1
        assert session.scalar(
            select(AppSetting.value).where(AppSetting.key == "shared-key")
        ) in {"one", "two"}
    engine.dispose()
