from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models.base import Base

_engine = None
_SessionFactory = None


def init_db() -> None:
    global _engine, _SessionFactory
    settings.ensure_dirs()
    _engine = create_engine(
        f"sqlite:///{settings.resolved_db_path()}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(_engine)
    _SessionFactory = sessionmaker(bind=_engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    if _SessionFactory is None:
        init_db()
    session = _SessionFactory()
    try:
        yield session
    finally:
        session.close()
