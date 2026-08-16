import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.models.classroom import Classroom, Student
from app.providers.pii_terms import roster_pii_terms


def _add_classroom(db_session: Session, name: str, students: list[Student]) -> None:
    classroom = Classroom(name=name, students=students)
    db_session.add(classroom)
    db_session.commit()


def test_collects_all_student_names_including_absent_students(
    db_session: Session, session_factory
) -> None:
    _add_classroom(
        db_session,
        "6-3",
        [
            Student(number=1, name="김미래"),
            Student(number=2, name="박균형", absent=True),
        ],
    )

    assert roster_pii_terms(session_factory)() == {"김미래", "박균형"}


def test_collects_names_across_classrooms(
    db_session: Session, session_factory
) -> None:
    _add_classroom(
        db_session,
        "6-1",
        [Student(number=1, name="이자율")],
    )
    _add_classroom(
        db_session,
        "6-2",
        [Student(number=1, name="최대칭")],
    )

    assert roster_pii_terms(session_factory)() == {"이자율", "최대칭"}


def test_empty_database_returns_empty_set(session_factory) -> None:
    assert roster_pii_terms(session_factory)() == set()


def test_short_names_are_excluded_and_names_are_stripped(
    db_session: Session, session_factory
) -> None:
    _add_classroom(
        db_session,
        "6-3",
        [
            Student(number=1, name="김"),
            Student(number=2, name="  김미래  "),
        ],
    )

    assert roster_pii_terms(session_factory)() == {"김미래"}


def test_each_call_uses_and_closes_a_fresh_session(engine) -> None:
    created_sessions: list[Session] = []
    closed_sessions: list[Session] = []

    class TrackingSession(Session):
        def __init__(self, **kwargs) -> None:
            super().__init__(**kwargs)
            created_sessions.append(self)

        def close(self) -> None:
            closed_sessions.append(self)
            super().close()

    factory = sessionmaker(
        bind=engine,
        class_=TrackingSession,
        expire_on_commit=False,
    )
    provider = roster_pii_terms(factory)

    provider()
    provider()

    assert len(created_sessions) == 2
    assert created_sessions[0] is not created_sessions[1]
    assert closed_sessions == created_sessions


def test_query_failure_closes_session_and_fails_closed() -> None:
    closed: list[bool] = []

    class FailingSession:
        def scalars(self, _statement):
            raise RuntimeError("private database detail")

        def close(self) -> None:
            closed.append(True)

    provider = roster_pii_terms(FailingSession)

    with pytest.raises(RuntimeError, match="private database detail"):
        provider()

    assert closed == [True]
