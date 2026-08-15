import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import sessionmaker

from app.api import settings as settings_api
from app.db import get_session
from app.models.app_setting import AppSetting
from app.models.base import Base
from app.providers.credentials import CredentialStore
from app.providers.gateway import TransmissionGateway
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
    yield store
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


def test_model_list_ignores_instance_shadow_and_keeps_audit(
    client, monkeypatch, tmp_path
):
    audit_path = tmp_path / "audit.log"
    provider = FakeLLMProvider(
        responses=[],
        models=["models/guarded"],
        gateway=TransmissionGateway(audit_path, set, "test-provider"),
    )
    bypass_calls = []
    provider.__dict__["list_models"] = lambda: (
        bypass_calls.append(True) or ["models/bypass"]
    )
    monkeypatch.setattr(settings_api, "build_provider", lambda api_key, model: provider)
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    response = client.get("/api/settings/models")

    assert response.status_code == 200
    assert response.json()["models"] == ["models/guarded"]
    assert bypass_calls == []
    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["provider"] == "test-provider"
    assert entry["purpose"] == "list_models"
    assert entry["pii_check"] == "pass"


def test_model_list_failure_does_not_expose_provider_error_or_key(client, monkeypatch):
    class FailedProvider(FakeLLMProvider):
        def _list_models(self, request):
            raise RuntimeError("request failed for api-key-secret")

    monkeypatch.setattr(
        settings_api,
        "build_provider",
        lambda api_key, model: FailedProvider(responses=[]),
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


def test_model_selection_ignores_instance_model_list_shadow(
    client, monkeypatch, tmp_path
):
    audit_path = tmp_path / "audit.log"
    provider = FakeLLMProvider(
        responses=[],
        models=["models/guarded"],
        gateway=TransmissionGateway(audit_path, set, "test-provider"),
    )
    bypass_calls = []
    provider.__dict__["list_models"] = lambda: (
        bypass_calls.append(True) or ["models/bypass"]
    )
    monkeypatch.setattr(settings_api, "build_provider", lambda api_key, model: provider)
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})

    response = client.put(
        "/api/settings/model", json={"llm_model": "models/guarded"}
    )

    assert response.status_code == 200
    assert response.json()["llm_model"] == "models/guarded"
    assert bypass_calls == []
    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["provider"] == "test-provider"
    assert entry["purpose"] == "list_models"
    assert entry["pii_check"] == "pass"


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
    class FailedProvider(FakeLLMProvider):
        def _list_models(self, request):
            raise RuntimeError("provider exposed api-key-secret")

    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})
    monkeypatch.setattr(
        settings_api,
        "build_provider",
        lambda api_key, model: FailedProvider(responses=[]),
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
    expected_wording = (
        "유료 등급 키를 사용 중이며 제출 내용이 모델 학습에 사용되지 않음을 "
        "확인했다"
    )
    assert settings_api.DATA_POLICY_WORDING_TEXT == expected_wording
    assert [entry.wording_text for entry in events] == [
        expected_wording,
        expected_wording,
    ]
    assert [entry.wording_version for entry in events] == [
        "paid-tier-no-training-v1",
        "paid-tier-no-training-v1",
    ]
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


def test_failed_keyring_delete_returns_error_and_invalidates_model(
    client, tmp_path, db_session
):
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
    assert body["llm_model"] is None
    assert settings_api.read_setting(
        db_session, "llm_model_key_fingerprint"
    ) is None


def test_model_binding_stores_fingerprint_not_key(
    client, db_session, stub_external_dependencies
):
    client.put("/api/settings/api-key", json={"api_key": "api-key-secret"})
    response = client.put(
        "/api/settings/model", json={"llm_model": "models/gemini-pro"}
    )

    fingerprint = settings_api.read_setting(
        db_session, "llm_model_key_fingerprint"
    )
    assert response.status_code == 200
    assert fingerprint is not None
    assert len(fingerprint) == 64
    assert fingerprint != "api-key-secret"


def test_model_is_hidden_when_current_key_does_not_match_binding(
    client, stub_external_dependencies
):
    store = stub_external_dependencies
    client.put("/api/settings/api-key", json={"api_key": "first-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-pro"})

    store.set_api_key("changed-outside-api")

    assert client.get("/api/settings").json()["llm_model"] is None


def test_pipeline_model_reader_rejects_binding_for_a_different_key(
    client, db_session, stub_external_dependencies
):
    store = stub_external_dependencies
    client.put("/api/settings/api-key", json={"api_key": "first-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-pro"})

    assert (
        settings_api.read_valid_llm_model(db_session, store)
        == "models/gemini-pro"
    )
    store.set_api_key("changed-outside-api")
    assert settings_api.read_valid_llm_model(db_session, store) is None


def test_key_save_partial_failure_invalidates_model_and_fingerprint(
    client, db_session, tmp_path
):
    fallback = tmp_path / "partial-save"
    keyring = FakeKeyring()
    store = CredentialStore(fallback, keyring)
    client.app.dependency_overrides[settings_api.get_credential_store] = lambda: store
    client.put("/api/settings/api-key", json={"api_key": "first-secret"})
    client.put("/api/settings/model", json={"llm_model": "models/gemini-pro"})
    fallback.mkdir()

    response = client.put(
        "/api/settings/api-key", json={"api_key": "second-secret"}
    )

    assert response.status_code == 503
    assert "second-secret" not in response.text
    assert settings_api.read_setting(db_session, "llm_model") is None
    assert settings_api.read_setting(
        db_session, "llm_model_key_fingerprint"
    ) is None
    body = client.get("/api/settings").json()
    assert body["api_key_set"] is True
    assert body["llm_model"] is None


def test_key_change_waits_for_model_binding_and_then_invalidates_it(
    client, engine, monkeypatch, tmp_path
):
    sessions = sessionmaker(bind=engine, expire_on_commit=False)

    def session_dependency():
        with sessions() as session:
            yield session

    client.app.dependency_overrides[get_session] = session_dependency
    model_list_started = Event()
    release_model_list = Event()
    new_key_store_started = Event()

    class SignallingKeyring(FakeKeyring):
        def set_password(self, service, name, value):
            if value == "second-secret":
                new_key_store_started.set()
            super().set_password(service, name, value)

    store = CredentialStore(tmp_path / "concurrent-key", SignallingKeyring())
    client.app.dependency_overrides[settings_api.get_credential_store] = lambda: store
    client.put("/api/settings/api-key", json={"api_key": "first-secret"})

    class BlockingProvider(FakeLLMProvider):
        def _list_models(self, request):
            model_list_started.set()
            assert release_model_list.wait(timeout=5)
            return ["models/gemini-pro"]

    monkeypatch.setattr(
        settings_api,
        "build_provider",
        lambda api_key, model: BlockingProvider(responses=[]),
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        model_future = executor.submit(
            client.put,
            "/api/settings/model",
            json={"llm_model": "models/gemini-pro"},
        )
        assert model_list_started.wait(timeout=5)
        key_future = executor.submit(
            client.put,
            "/api/settings/api-key",
            json={"api_key": "second-secret"},
        )
        assert not new_key_store_started.wait(timeout=0.2)
        release_model_list.set()
        assert model_future.result(timeout=5).status_code == 200
        assert key_future.result(timeout=5).status_code == 200

    body = client.get("/api/settings").json()
    assert body["api_key_set"] is True
    assert body["llm_model"] is None


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
