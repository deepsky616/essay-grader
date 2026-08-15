from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models.app_setting import (
    DATA_POLICY_WORDING_TEXT,
    DATA_POLICY_WORDING_VERSION,
)
from app.models.base import Base

_engine = None
_SessionFactory = None


def migrate_schema(engine: Engine) -> None:
    """작은 SQLite 표 변화를 반복 가능하게 적용한다."""
    with engine.connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            table_exists = connection.exec_driver_sql(
                """
                SELECT 1
                FROM sqlite_master
                WHERE type = 'table' AND name = 'data_policy_acknowledgements'
                """
            ).first()
            if table_exists is not None:
                columns = connection.exec_driver_sql(
                    'PRAGMA table_info("data_policy_acknowledgements")'
                ).all()
                if "wording_text" not in {column[1] for column in columns}:
                    connection.exec_driver_sql(
                        """
                        ALTER TABLE data_policy_acknowledgements
                        ADD COLUMN wording_text TEXT NULL
                        """
                    )

                connection.execute(
                    text(
                        """
                        UPDATE data_policy_acknowledgements
                        SET wording_text = :wording_text
                        WHERE wording_version = :wording_version
                        """
                    ),
                    {
                        "wording_text": DATA_POLICY_WORDING_TEXT,
                        "wording_version": DATA_POLICY_WORDING_VERSION,
                    },
                )
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()


def init_db() -> None:
    global _engine, _SessionFactory
    settings.ensure_dirs()
    candidate_engine = create_engine(
        f"sqlite:///{settings.resolved_db_path()}",
        connect_args={"check_same_thread": False},
    )
    try:
        Base.metadata.create_all(candidate_engine)
        migrate_schema(candidate_engine)
    except Exception:
        candidate_engine.dispose()
        raise

    previous_engine = _engine
    _engine = candidate_engine
    _SessionFactory = sessionmaker(bind=candidate_engine, expire_on_commit=False)
    if previous_engine is not None:
        previous_engine.dispose()


def get_session() -> Iterator[Session]:
    if _SessionFactory is None:
        init_db()
    session = _SessionFactory()
    try:
        yield session
    finally:
        session.close()
