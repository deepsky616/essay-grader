import pytest

from app.config import settings
from app.models.grading import GradingRun, ItemScore
from app.models.rubric import RubricDraft
from app.models.scan import ItemResponse


@pytest.fixture
def with_rubric(graded_setup, db_session):
    db_session.add(
        RubricDraft(
            assessment_id=graded_setup["assessment"].id,
            confirmed=True,
            content={
                "assessment": {
                    "title": "가",
                    "subject": "수학",
                    "grade": 6,
                    "total_points": 4,
                },
                "achievement_standards": [],
                "items": [
                    {
                        "item_no": 1,
                        "title": "대칭축 찾기",
                        "points": 2,
                        "type": "closed_short",
                        "blanks": [
                            {"key": "1", "answers": ["선대칭"], "aliases": []}
                        ],
                        "scoring": [
                            {
                                "score": 2,
                                "condition": "all_correct",
                                "criterion": "둘 다 정확",
                            },
                            {
                                "score": 1,
                                "condition": "partial:1",
                                "criterion": "하나만",
                            },
                            {
                                "score": 0,
                                "condition": "none_correct",
                                "criterion": "모두 틀림",
                            },
                        ],
                        "example_answer": "1 선대칭 2 점대칭",
                    },
                    {
                        "item_no": 2,
                        "title": "점대칭 도형 그리기",
                        "points": 2,
                        "type": "drawing",
                        "scoring": [
                            {
                                "score": 2,
                                "condition": "manual",
                                "criterion": "정확하게 완성",
                            },
                            {
                                "score": 0,
                                "condition": "manual",
                                "criterion": "그리지 못함",
                            },
                        ],
                        "example_answer": "예시 그림 참조",
                    },
                ],
                "level_cutoffs": {"3": 4, "2": 2, "1": 0},
            },
        )
    )
    db_session.commit()
    return graded_setup


def test_queue_groups_by_item(with_rubric, client):
    body = client.get(
        f"/api/review/runs/{with_rubric['run'].id}/queue"
    ).json()

    assert [group["item_no"] for group in body["items"]] == [1, 2]
    assert body["items"][0]["title"] == "대칭축 찾기"
    assert body["items"][0]["points"] == 2
    assert body["items"][0]["pending"] == 2


def test_queue_includes_rubric_criteria(with_rubric, client):
    body = client.get(
        f"/api/review/runs/{with_rubric['run'].id}/queue"
    ).json()

    criteria = body["items"][0]["scoring"]
    assert [rule["score"] for rule in criteria] == [2, 1, 0]
    assert criteria[0]["criterion"] == "둘 다 정확"


def test_item_scores_listed_in_student_order(with_rubric, client):
    body = client.get(
        f"/api/review/runs/{with_rubric['run'].id}/items/1"
    ).json()

    assert [row["student_name"] for row in body["scores"]] == [
        "김미래",
        "박균형",
    ]
    assert body["example_answer"] == "1 선대칭 2 점대칭"


def test_pending_filter(with_rubric, client, db_session):
    run_id = with_rubric["run"].id
    first = db_session.query(ItemScore).filter_by(run_id=run_id, item_no=1).first()
    client.post(f"/api/review/scores/{first.id}/confirm", json={"score": 2})

    body = client.get(
        f"/api/review/runs/{run_id}/items/1?pending_only=true"
    ).json()
    assert len(body["scores"]) == 1


def test_confirm_accepts_proposal_and_records_actor(
    with_rubric, client, db_session
):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    response = client.post(
        f"/api/review/scores/{score.id}/confirm",
        json={"score": 2},
    )

    assert response.status_code == 200
    assert response.json()["final_score"] == 2
    assert response.json()["confirmed"] is True
    history = client.get(f"/api/review/scores/{score.id}/history").json()
    assert history["revisions"][0]["actor"] == "local_teacher"


def test_confirm_rejects_score_above_item_points(
    with_rubric, client, db_session
):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    response = client.post(
        f"/api/review/scores/{score.id}/confirm",
        json={"score": 9},
    )

    assert response.status_code == 400
    assert "배점" in response.json()["detail"]


@pytest.mark.parametrize("invalid_score", [True, 1.5, "2", -1])
def test_confirm_rejects_non_contract_scores(
    with_rubric, client, db_session, invalid_score
):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    response = client.post(
        f"/api/review/scores/{score.id}/confirm",
        json={"score": invalid_score},
    )

    assert response.status_code == 422


def test_confirm_records_trimmed_note(with_rubric, client, db_session):
    score = db_session.query(ItemScore).filter_by(item_no=1).first()
    client.post(
        f"/api/review/scores/{score.id}/confirm",
        json={"score": 1, "note": "  계산 과정 누락  "},
    )

    history = client.get(f"/api/review/scores/{score.id}/history").json()
    assert history["revisions"][0]["note"] == "계산 과정 누락"


def test_bulk_accept_endpoint(with_rubric, client):
    response = client.post(
        f"/api/review/runs/{with_rubric['run'].id}/bulk-accept"
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 2


def test_bulk_accept_rejects_corrupt_proposal_atomically(
    with_rubric, client, db_session
):
    run_id = with_rubric["run"].id
    first = db_session.query(ItemScore).filter_by(run_id=run_id, item_no=1).first()
    first.proposed_score = 9
    db_session.commit()

    response = client.post(f"/api/review/runs/{run_id}/bulk-accept")

    assert response.status_code == 400
    assert not any(
        row.confirmed
        for row in db_session.query(ItemScore).filter_by(run_id=run_id)
    )


def test_progress_endpoint(with_rubric, client):
    run_id = with_rubric["run"].id
    client.post(f"/api/review/runs/{run_id}/bulk-accept")

    body = client.get(f"/api/review/runs/{run_id}/progress").json()
    assert body == {"total": 4, "confirmed": 2, "pending": 2, "complete": False}


def test_totals_endpoint_is_scoped_to_selected_run(
    with_rubric, client, db_session
):
    run = with_rubric["run"]
    for score in db_session.query(ItemScore).filter_by(run_id=run.id):
        client.post(
            f"/api/review/scores/{score.id}/confirm",
            json={"score": 2},
        )

    old_run = GradingRun(batch_id=run.batch_id, status="succeeded")
    db_session.add(old_run)
    db_session.commit()
    selected = db_session.query(ItemScore).filter_by(run_id=run.id).all()
    db_session.add_all(
        [
            ItemScore(
                run_id=old_run.id,
                submission_id=row.submission_id,
                item_no=row.item_no,
                proposed_score=0,
                final_score=0,
                confirmed=True,
                reason="이전 실행",
                route="auto",
            )
            for row in selected
        ]
    )
    db_session.commit()

    body = client.get(f"/api/review/runs/{run.id}/totals").json()
    assert len(body["students"]) == 2
    assert body["students"][0]["total"] == 4
    assert body["students"][0]["complete"] is True


def test_crop_image_is_served_from_batch_storage(
    with_rubric, client, db_session
):
    crop = settings.data_dir / "batches" / "1" / "crop.png"
    crop.parent.mkdir(parents=True)
    crop.write_bytes(b"\x89PNG\r\n\x1a\n" + b"safe")
    response_row = db_session.query(ItemResponse).first()
    response_row.crop_path = str(crop)
    db_session.commit()
    score = (
        db_session.query(ItemScore)
        .filter_by(
            submission_id=response_row.submission_id,
            item_no=response_row.item_no,
        )
        .first()
    )

    result = client.get(f"/api/review/scores/{score.id}/crop")
    assert result.status_code == 200
    assert result.headers["content-type"] == "image/png"


def test_crop_outside_batch_storage_is_not_served(
    with_rubric, client, db_session, tmp_path
):
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"\x89PNG\r\n\x1a\nunsafe")
    response_row = db_session.query(ItemResponse).first()
    response_row.crop_path = str(outside)
    db_session.commit()
    score = db_session.query(ItemScore).filter_by(
        submission_id=response_row.submission_id,
        item_no=response_row.item_no,
    ).first()

    assert client.get(f"/api/review/scores/{score.id}/crop").status_code == 404


def test_crop_symbolic_link_is_not_served(with_rubric, client, db_session):
    root = settings.data_dir / "batches" / "1"
    root.mkdir(parents=True)
    target = root / "target.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\nsafe")
    link = root / "linked.png"
    link.symlink_to(target)
    response_row = db_session.query(ItemResponse).first()
    response_row.crop_path = str(link)
    db_session.commit()
    score = db_session.query(ItemScore).filter_by(
        submission_id=response_row.submission_id,
        item_no=response_row.item_no,
    ).first()

    assert client.get(f"/api/review/scores/{score.id}/crop").status_code == 404


def test_missing_crop_returns_404(with_rubric, client, db_session):
    score = db_session.query(ItemScore).filter_by(item_no=2).first()
    assert client.get(f"/api/review/scores/{score.id}/crop").status_code == 404


def test_missing_score_history_returns_404(with_rubric, client):
    assert client.get("/api/review/scores/999/history").status_code == 404


def test_accuracy_endpoint(with_rubric, client):
    run_id = with_rubric["run"].id
    client.post(f"/api/review/runs/{run_id}/bulk-accept")

    body = client.get(f"/api/review/runs/{run_id}/accuracy").json()
    assert body["auto_route_is_safe"] is True
    assert body["by_type"]["closed_short"]["agreement_rate"] == 1.0


def test_failed_run_cannot_be_reviewed(with_rubric, client, db_session):
    run = with_rubric["run"]
    run.status = "failed"
    run.failure_reason = "실패"
    db_session.commit()

    response = client.get(f"/api/review/runs/{run.id}/queue")
    assert response.status_code == 409


def test_unconfirmed_rubric_cannot_be_used(with_rubric, client, db_session):
    draft = db_session.query(RubricDraft).one()
    draft.confirmed = False
    db_session.commit()

    response = client.get(f"/api/review/runs/{with_rubric['run'].id}/queue")
    assert response.status_code == 400
