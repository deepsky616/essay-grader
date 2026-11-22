import pytest
from sqlalchemy.exc import IntegrityError

from app.models.assessment import Assessment
from app.models.classroom import Classroom, Student
from app.models.grading import GradingRun, ItemScore
from app.models.scan import ScanBatch, Submission


def _submission(db_session) -> Submission:
    assessment = Assessment(
        title="가",
        subject="수학",
        grade=6,
        total_points=20,
    )
    classroom = Classroom(name="6-3")
    classroom.students = [Student(number=1, name="김미래")]
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

    submission = Submission(
        batch_id=batch.id,
        student_id=classroom.students[0].id,
        page_start=0,
        page_end=3,
        assignment_status="confirmed",
    )
    db_session.add(submission)
    db_session.commit()
    return submission


def test_grading_run_and_scores(db_session):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="running")
    db_session.add(run)
    db_session.commit()

    db_session.add(
        ItemScore(
            run_id=run.id,
            submission_id=submission.id,
            item_no=1,
            proposed_score=2,
            matched_criterion="둘 다 정확하게 씀",
            evidence="선대칭, 점대칭",
            reason="정답 2/2",
            confidence=0.95,
            route="auto",
        )
    )
    db_session.commit()

    loaded = db_session.get(GradingRun, run.id)
    assert len(loaded.scores) == 1
    score = loaded.scores[0]
    assert score.proposed_score == 2
    assert score.final_score is None
    assert score.confirmed is False


def test_item_score_defaults(db_session):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="running")
    db_session.add(run)
    db_session.commit()

    score = ItemScore(
        run_id=run.id,
        submission_id=submission.id,
        item_no=3,
        proposed_score=None,
        route="manual",
        reason="작도 문항",
    )
    db_session.add(score)
    db_session.commit()

    loaded = db_session.get(ItemScore, score.id)
    assert loaded.confidence == 0.0
    assert loaded.part_scores == {}
    assert loaded.routing_reasons == []


def test_duplicate_item_score_is_rejected(db_session):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="running")
    db_session.add(run)
    db_session.commit()
    for _ in range(2):
        db_session.add(
            ItemScore(
                run_id=run.id,
                submission_id=submission.id,
                item_no=1,
                route="manual",
                reason="검토",
            )
        )
    with pytest.raises(IntegrityError):
        db_session.commit()


@pytest.mark.parametrize(
    "values",
    [
        {"status": "unknown"},
        {"confidence_threshold": -0.1},
        {"confidence_threshold": 1.1},
        {"status": "failed", "failure_reason": None},
        {"status": "running", "failure_reason": "실패"},
    ],
)
def test_grading_run_constraints_fail_closed(db_session, values):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="pending")
    for key, value in values.items():
        setattr(run, key, value)
    db_session.add(run)
    with pytest.raises(IntegrityError):
        db_session.commit()


@pytest.mark.parametrize(
    "values",
    [
        {"item_no": 0},
        {"confidence": -0.1},
        {"confidence": 1.1},
        {"route": "maybe"},
        {"proposed_score": -1},
        {"final_score": 1, "confirmed": False},
        {"final_score": None, "confirmed": True},
    ],
)
def test_item_score_constraints_fail_closed(db_session, values):
    submission = _submission(db_session)
    run = GradingRun(batch_id=submission.batch_id, status="running")
    db_session.add(run)
    db_session.commit()
    defaults = {
        "item_no": 1,
        "confidence": 0.5,
        "route": "manual",
        "proposed_score": None,
        "final_score": None,
        "confirmed": False,
    }
    defaults.update(values)
    db_session.add(
        ItemScore(
            run_id=run.id,
            submission_id=submission.id,
            reason="검토",
            **defaults,
        )
    )
    with pytest.raises(IntegrityError):
        db_session.commit()
