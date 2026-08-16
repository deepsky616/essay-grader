import pytest
from sqlalchemy.exc import IntegrityError

from app.models.review import ScoreRevision


def test_revision_records_before_and_after(db_session, item_score):
    revision = ScoreRevision(
        item_score_id=item_score.id,
        previous_score=2,
        new_score=1,
        source="teacher_edit",
        note="풀이 과정에 오류가 있어 감점",
    )
    db_session.add(revision)
    db_session.commit()

    loaded = db_session.get(ScoreRevision, revision.id)
    assert loaded.previous_score == 2
    assert loaded.new_score == 1
    assert loaded.source == "teacher_edit"


def test_revision_allows_null_previous_score(db_session, item_score):
    revision = ScoreRevision(
        item_score_id=item_score.id,
        previous_score=None,
        new_score=4,
        source="teacher_edit",
    )
    db_session.add(revision)
    db_session.commit()

    assert db_session.get(ScoreRevision, revision.id).previous_score is None


@pytest.mark.parametrize(
    ("field", "value"),
    [("previous_score", -1), ("new_score", -1), ("source", "unknown")],
)
def test_revision_rejects_invalid_audit_values(
    db_session, item_score, field, value
):
    values = {
        "item_score_id": item_score.id,
        "previous_score": 2,
        "new_score": 1,
        "source": "teacher_edit",
    }
    values[field] = value
    db_session.add(ScoreRevision(**values))

    with pytest.raises(IntegrityError):
        db_session.commit()
