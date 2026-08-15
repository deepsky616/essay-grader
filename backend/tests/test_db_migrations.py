import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event

from app import db as db_module
from app.api import settings as settings_api
from app.config import settings
from app.main import create_app
from app.models.app_setting import DATA_POLICY_WORDING_TEXT
from app.models.base import Base
from app.providers.credentials import CredentialStore
from tests.fakes import FakeKeyring


def _create_legacy_policy_table(database_path):
    engine = create_engine(f"sqlite:///{database_path}")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            """
            CREATE TABLE data_policy_acknowledgements (
                id INTEGER PRIMARY KEY,
                wording_version VARCHAR(80) NOT NULL,
                acknowledged BOOLEAN NOT NULL,
                confirmed_at DATETIME NOT NULL
            )
            """
        )
        connection.exec_driver_sql(
            """
            INSERT INTO data_policy_acknowledgements
                (id, wording_version, acknowledged, confirmed_at)
            VALUES
                (1, 'paid-tier-no-training-v1', 1, '2026-08-15 10:00:00'),
                (2, 'unknown-policy-v9', 1, '2026-08-15 11:00:00')
            """
        )
    engine.dispose()


@pytest.fixture
def isolated_db_globals():
    previous_engine = db_module._engine
    previous_factory = db_module._SessionFactory
    db_module._engine = None
    db_module._SessionFactory = None
    yield
    if db_module._engine is not None:
        db_module._engine.dispose()
    db_module._engine = previous_engine
    db_module._SessionFactory = previous_factory


def test_policy_wording_migration_backfills_known_version_and_is_repeatable(tmp_path):
    database_path = tmp_path / "legacy.db"
    _create_legacy_policy_table(database_path)
    engine = create_engine(f"sqlite:///{database_path}")

    db_module.migrate_schema(engine)
    db_module.migrate_schema(engine)

    with engine.connect() as connection:
        columns = connection.exec_driver_sql(
            'PRAGMA table_info("data_policy_acknowledgements")'
        ).all()
        events = connection.exec_driver_sql(
            """
            SELECT wording_version, wording_text
            FROM data_policy_acknowledgements
            ORDER BY id
            """
        ).all()
    assert [column[1] for column in columns].count("wording_text") == 1
    assert events == [
        ("paid-tier-no-training-v1", DATA_POLICY_WORDING_TEXT),
        ("unknown-policy-v9", None),
    ]
    engine.dispose()


def test_migration_is_safe_for_new_database_and_repeatable(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'new.db'}")
    Base.metadata.create_all(engine)

    db_module.migrate_schema(engine)
    db_module.migrate_schema(engine)

    with engine.connect() as connection:
        columns = connection.exec_driver_sql(
            'PRAGMA table_info("data_policy_acknowledgements")'
        ).all()
    assert [column[1] for column in columns].count("wording_text") == 1
    engine.dispose()


def test_migration_rolls_back_column_addition_when_backfill_fails(tmp_path):
    database_path = tmp_path / "rollback.db"
    _create_legacy_policy_table(database_path)
    engine = create_engine(f"sqlite:///{database_path}")

    def fail_backfill(connection, cursor, statement, *arguments):
        if statement.lstrip().upper().startswith("UPDATE"):
            raise RuntimeError("backfill failed")

    event.listen(engine, "before_cursor_execute", fail_backfill)
    try:
        with pytest.raises(RuntimeError, match="backfill failed"):
            db_module.migrate_schema(engine)
    finally:
        event.remove(engine, "before_cursor_execute", fail_backfill)

    with engine.connect() as connection:
        columns = connection.exec_driver_sql(
            'PRAGMA table_info("data_policy_acknowledgements")'
        ).all()
    assert "wording_text" not in {column[1] for column in columns}
    engine.dispose()


def test_init_db_migrates_legacy_database_before_settings_api_use(
    tmp_path, monkeypatch, isolated_db_globals
):
    database_path = tmp_path / "legacy-api.db"
    _create_legacy_policy_table(database_path)
    monkeypatch.setattr(settings, "db_path", database_path)
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")

    db_module.init_db()

    app = create_app()
    store = CredentialStore(tmp_path / "credential", FakeKeyring())
    app.dependency_overrides[settings_api.get_credential_store] = lambda: store
    with TestClient(app) as client:
        assert client.get("/api/settings").status_code == 200
        response = client.put(
            "/api/settings/data-policy", json={"acknowledged": True}
        )
        assert response.status_code == 200

    with db_module._engine.connect() as connection:
        events = connection.exec_driver_sql(
            """
            SELECT wording_version, wording_text
            FROM data_policy_acknowledgements
            ORDER BY id
            """
        ).all()
    assert events == [
        ("paid-tier-no-training-v1", DATA_POLICY_WORDING_TEXT),
        ("unknown-policy-v9", None),
        ("paid-tier-no-training-v1", DATA_POLICY_WORDING_TEXT),
    ]


def test_init_db_propagates_migration_failure(
    tmp_path, monkeypatch, isolated_db_globals
):
    monkeypatch.setattr(settings, "db_path", tmp_path / "failed.db")

    def fail_migration(engine):
        raise RuntimeError("migration failed")

    monkeypatch.setattr(db_module, "migrate_schema", fail_migration)

    with pytest.raises(RuntimeError, match="migration failed"):
        db_module.init_db()

    assert db_module._SessionFactory is None
