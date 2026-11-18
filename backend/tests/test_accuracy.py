from app.models.grading import ItemScore
from app.services.accuracy import compute_accuracy
from app.services.confirmation import confirm_score


RUBRIC_TYPES = {1: "closed_short", 2: "drawing"}


def test_all_accepted_gives_full_agreement(graded_setup, db_session):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1):
        confirm_score(
            db_session,
            score,
            new_score=score.proposed_score,
            source="teacher_accept",
        )

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.confirmed == 2
    assert row.agreed == 2
    assert row.agreement_rate == 1.0


def test_edits_reduce_agreement(graded_setup, db_session):
    run = graded_setup["run"]
    scores = list(db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1))
    confirm_score(db_session, scores[0], new_score=2, source="teacher_accept")
    confirm_score(db_session, scores[1], new_score=1, source="teacher_edit")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.agreed == 1
    assert row.agreement_rate == 0.5


def test_items_without_proposal_are_excluded(graded_setup, db_session):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=2):
        confirm_score(db_session, score, new_score=2, source="teacher_edit")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 2)
    assert row.confirmed == 0
    assert row.agreement_rate is None


def test_unconfirmed_items_are_not_counted(graded_setup, db_session):
    report = compute_accuracy(db_session, graded_setup["run"].id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.confirmed == 0
    assert row.agreement_rate is None


def test_grouped_by_item_type(graded_setup, db_session):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1):
        confirm_score(
            db_session,
            score,
            new_score=score.proposed_score,
            source="teacher_accept",
        )

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    assert report.by_type["closed_short"].agreement_rate == 1.0


def test_auto_route_disagreement_is_flagged(graded_setup, db_session):
    run = graded_setup["run"]
    score = db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1).first()
    confirm_score(db_session, score, new_score=0, source="teacher_edit")

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    assert report.auto_route_disagreements == 1
    assert report.auto_route_is_safe is False


def test_auto_route_is_safe_when_reviewed_without_disagreement(
    graded_setup, db_session
):
    run = graded_setup["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1):
        confirm_score(
            db_session,
            score,
            new_score=score.proposed_score,
            source="teacher_accept",
        )

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    assert report.auto_route_is_safe is True


def test_no_reviewed_auto_items_is_not_reported_as_safe(graded_setup, db_session):
    report = compute_accuracy(db_session, graded_setup["run"].id, RUBRIC_TYPES)

    assert report.auto_route_confirmed == 0
    assert report.auto_route_is_safe is False


def test_confirmed_flag_without_revision_is_not_a_teacher_measurement(
    graded_setup, db_session
):
    run = graded_setup["run"]
    score = db_session.query(ItemScore).filter_by(run_id=run.id, item_no=1).first()
    score.final_score = score.proposed_score
    score.confirmed = True
    db_session.commit()

    report = compute_accuracy(db_session, run.id, RUBRIC_TYPES)
    row = next(row for row in report.by_item if row.item_no == 1)
    assert row.confirmed == 0
