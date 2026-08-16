import pytest
from sqlalchemy.exc import IntegrityError

from app.models.feedback import Feedback
from app.models.scan import Submission


def _feedback(graded_setup, db_session, **overrides):
    submission = db_session.query(Submission).first()
    values = {
        "run_id": graded_setup["run"].id,
        "submission_id": submission.id,
        "total_score": 4,
        "level": "3",
        "item_comments": [
            {"item_no": 1, "score": 2, "max": 2, "comment": "잘했어요"}
        ],
        "summary": "전체적으로 잘 이해하고 있어요.",
        "next_step": "점대칭 도형을 더 연습해 보세요.",
    }
    values.update(overrides)
    return Feedback(**values)


def test_feedback_persists(db_session, graded_setup):
    feedback = _feedback(graded_setup, db_session)
    db_session.add(feedback)
    db_session.commit()

    loaded = db_session.get(Feedback, feedback.id)
    assert loaded.total_score == 4
    assert loaded.level == "3"
    assert loaded.item_comments[0]["comment"] == "잘했어요"


def test_feedback_defaults(db_session, graded_setup):
    submission = db_session.query(Submission).first()
    feedback = Feedback(
        run_id=graded_setup["run"].id,
        submission_id=submission.id,
        total_score=0,
    )
    db_session.add(feedback)
    db_session.commit()

    loaded = db_session.get(Feedback, feedback.id)
    assert loaded.item_comments == []
    assert loaded.summary == ""
    assert loaded.next_step == ""


@pytest.mark.parametrize(
    ("field", "value"),
    [("total_score", -1), ("level", "4")],
)
def test_feedback_rejects_invalid_scalar_values(
    db_session, graded_setup, field, value
):
    db_session.add(_feedback(graded_setup, db_session, **{field: value}))
    with pytest.raises(IntegrityError):
        db_session.commit()


def test_feedback_is_unique_per_run_and_submission(db_session, graded_setup):
    db_session.add(_feedback(graded_setup, db_session))
    db_session.commit()
    db_session.add(_feedback(graded_setup, db_session))

    with pytest.raises(IntegrityError):
        db_session.commit()
