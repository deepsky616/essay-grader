import pytest

from app.models.grading import ItemScore
from app.models.review import ScoreRevision
from app.services.confirmation import (
    ConfirmationError,
    bulk_accept_auto,
    confirm_score,
    submission_total,
)


def _score(db_session, route="auto", proposed=2, item_no=1) -> ItemScore:
    query = db_session.query(ItemScore).filter_by(route=route, item_no=item_no)
    if proposed is None:
        query = query.filter(ItemScore.proposed_score.is_(None))
    else:
        query = query.filter(ItemScore.proposed_score == proposed)
    return query.first()


def test_accepting_proposal_records_revision(graded_setup, db_session):
    score = _score(db_session)
    confirm_score(db_session, score, new_score=2, source="teacher_accept")

    assert score.final_score == 2
    assert score.confirmed is True
    revisions = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).all()
    assert len(revisions) == 1
    assert revisions[0].previous_score == 2
    assert revisions[0].new_score == 2


def test_changing_score_records_both_values(graded_setup, db_session):
    score = _score(db_session)
    confirm_score(
        db_session,
        score,
        new_score=1,
        source="teacher_edit",
        note="일부 오류",
    )

    assert score.final_score == 1
    revision = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).one()
    assert revision.previous_score == 2
    assert revision.new_score == 1
    assert revision.note == "일부 오류"


def test_scoring_an_item_without_proposal(graded_setup, db_session):
    score = _score(db_session, route="manual", proposed=None, item_no=2)
    confirm_score(db_session, score, new_score=2, source="teacher_edit")

    assert score.final_score == 2
    revision = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).one()
    assert revision.previous_score is None


def test_reconfirming_appends_another_revision(graded_setup, db_session):
    score = _score(db_session)
    confirm_score(db_session, score, new_score=2, source="teacher_accept")
    confirm_score(db_session, score, new_score=0, source="teacher_edit")

    revisions = db_session.query(ScoreRevision).filter_by(item_score_id=score.id).all()
    assert len(revisions) == 2
    assert revisions[1].previous_score == 2
    assert score.final_score == 0


@pytest.mark.parametrize("new_score", [-1, 1.5, True])
def test_invalid_score_is_rejected(graded_setup, db_session, new_score):
    score = _score(db_session)
    with pytest.raises(ConfirmationError, match="점수"):
        confirm_score(
            db_session,
            score,
            new_score=new_score,
            source="teacher_edit",
        )


def test_score_above_item_points_is_rejected(graded_setup, db_session):
    score = _score(db_session)
    with pytest.raises(ConfirmationError, match="배점"):
        confirm_score(
            db_session,
            score,
            new_score=5,
            source="teacher_edit",
            max_points=2,
        )


def test_invalid_source_is_rejected_without_writing(graded_setup, db_session):
    score = _score(db_session)
    with pytest.raises(ConfirmationError, match="출처"):
        confirm_score(db_session, score, new_score=2, source="unknown")

    assert score.confirmed is False
    assert db_session.query(ScoreRevision).count() == 0


def test_bulk_accept_only_touches_auto_route(graded_setup, db_session):
    run = graded_setup["run"]
    count = bulk_accept_auto(db_session, run.id)

    assert count == 2
    autos = db_session.query(ItemScore).filter_by(run_id=run.id, route="auto").all()
    assert all(score.confirmed for score in autos)

    manuals = db_session.query(ItemScore).filter_by(run_id=run.id, route="manual").all()
    assert not any(score.confirmed for score in manuals)


def test_bulk_accept_skips_already_confirmed(graded_setup, db_session):
    run = graded_setup["run"]
    bulk_accept_auto(db_session, run.id)
    assert bulk_accept_auto(db_session, run.id) == 0


def test_bulk_accept_skips_items_without_proposal(graded_setup, db_session):
    run = graded_setup["run"]
    score = _score(db_session)
    score.proposed_score = None
    db_session.commit()

    assert bulk_accept_auto(db_session, run.id) == 1


def test_submission_total_sums_confirmed_scores(graded_setup, db_session):
    submission_id = db_session.query(ItemScore).first().submission_id
    scores = db_session.query(ItemScore).filter_by(submission_id=submission_id).all()
    for score in scores:
        confirm_score(db_session, score, new_score=2, source="teacher_accept")

    total = submission_total(db_session, submission_id)
    assert total.points == 4
    assert total.complete is True


def test_submission_total_reports_incomplete(graded_setup, db_session):
    submission_id = db_session.query(ItemScore).first().submission_id
    first = db_session.query(ItemScore).filter_by(submission_id=submission_id).first()
    confirm_score(db_session, first, new_score=2, source="teacher_accept")

    total = submission_total(db_session, submission_id)
    assert total.complete is False
    assert total.pending == 1
