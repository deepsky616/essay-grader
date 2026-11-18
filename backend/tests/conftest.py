import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import create_app
from app.models.base import Base


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """테스트가 사용자 홈의 실제 자료 폴더를 건드리지 않게 격리한다."""
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    monkeypatch.setattr(settings, "db_path", tmp_path / "data" / "test.db")
    settings.ensure_dirs()


@pytest.fixture
def engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(
        engine,
        "connect",
        lambda dbapi_connection, _: dbapi_connection.execute(
            "PRAGMA foreign_keys=ON"
        ),
    )
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(engine):
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = factory()
    yield session
    session.close()


@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, expire_on_commit=False)


@pytest.fixture
def client(engine, db_session):
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db_session
    return TestClient(app)


@pytest.fixture
def graded_setup(db_session):
    """확정 대기 상태인 채점 결과 한 벌을 만든다."""
    from app.models.assessment import Assessment
    from app.models.classroom import Classroom, Student
    from app.models.grading import GradingRun, ItemScore
    from app.models.scan import ItemResponse, ScanBatch, Submission

    assessment = Assessment(title="가", subject="수학", grade=6, total_points=4)
    classroom = Classroom(name="6-3")
    classroom.students = [
        Student(number=1, name="김미래"),
        Student(number=2, name="박균형"),
    ]
    db_session.add_all([assessment, classroom])
    db_session.commit()

    batch = ScanBatch(
        assessment_id=assessment.id,
        classroom_id=classroom.id,
        stored_path="/tmp/s.pdf",
        status="ready",
    )
    db_session.add(batch)
    db_session.commit()

    run = GradingRun(batch_id=batch.id, status="succeeded")
    db_session.add(run)
    db_session.commit()

    scores = []
    for index, student in enumerate(classroom.students):
        submission = Submission(
            batch_id=batch.id,
            student_id=student.id,
            page_start=index,
            page_end=index + 1,
            assignment_status="confirmed",
            anonymous_token=f"S-{index + 1:08d}",
        )
        db_session.add(submission)
        db_session.commit()

        db_session.add(
            ItemResponse(
                submission_id=submission.id,
                item_no=1,
                crop_path=f"/tmp/c{index}.png",
            )
        )
        scores.extend(
            [
                ItemScore(
                    run_id=run.id,
                    submission_id=submission.id,
                    item_no=1,
                    proposed_score=2,
                    matched_criterion="둘 다 정확",
                    evidence="선대칭, 점대칭",
                    reason="정답 2/2",
                    confidence=0.96,
                    route="auto",
                ),
                ItemScore(
                    run_id=run.id,
                    submission_id=submission.id,
                    item_no=2,
                    proposed_score=None,
                    reason="작도 문항",
                    route="manual",
                ),
            ]
        )
    db_session.add_all(scores)
    db_session.commit()

    return {
        "assessment": assessment,
        "classroom": classroom,
        "batch": batch,
        "run": run,
    }


@pytest.fixture
def item_score(graded_setup, db_session):
    from app.models.grading import ItemScore

    return db_session.query(ItemScore).first()
