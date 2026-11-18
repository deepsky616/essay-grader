import pytest

from app.api import grading as grading_api
from app.api import scans as scans_api
from app.api import settings as settings_api
from app.config import settings
from app.models.grading import GradingRun, ItemScore
from app.models.scan import ItemResponse, ScanBatch, Submission
from app.providers.credentials import CredentialStore
from app.services.grading_pipeline import ScoredItem
from tests.fakes import FakeKeyring, make_fake_llm_provider


@pytest.fixture
def credential_store(client, tmp_path):
    store = CredentialStore(tmp_path / "credential", FakeKeyring())
    client.app.dependency_overrides[settings_api.get_credential_store] = lambda: store
    yield store
    client.app.dependency_overrides.pop(settings_api.get_credential_store, None)


@pytest.fixture(autouse=True)
def stub_model_listing(monkeypatch):
    monkeypatch.setattr(
        settings_api,
        "build_provider",
        lambda api_key, model: make_fake_llm_provider(
            responses=[],
            models=["models/gemini-pro"],
        )[0],
    )


@pytest.fixture(autouse=True)
def stub_job_runner(monkeypatch):
    submitted = []

    class Runner:
        def submit(self, job_type, payload, handler):
            submitted.append((job_type, payload, handler))
            return len(submitted)

    monkeypatch.setattr(scans_api, "_runner", Runner())
    return submitted


@pytest.fixture
def ready_batch(client, db_session):
    from app.models.assessment import Assessment
    from app.models.classroom import Classroom, Student
    from app.models.rubric import RubricDraft

    assessment = Assessment(title="가", subject="수학", grade=6, total_points=2)
    classroom = Classroom(name="6-3")
    classroom.students = [Student(number=1, name="김미래")]
    db_session.add_all([assessment, classroom])
    db_session.commit()

    db_session.add(
        RubricDraft(
            assessment_id=assessment.id,
            confirmed=True,
            content={
                "assessment": {
                    "title": "가",
                    "subject": "수학",
                    "grade": 6,
                    "total_points": 2,
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
                            {"score": 2, "condition": "all_correct", "criterion": "정확"},
                            {"score": 0, "condition": "none_correct", "criterion": "틀림"},
                        ],
                        "example_answer": "선대칭",
                    }
                ],
                "level_cutoffs": {},
            },
        )
    )
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
        page_end=1,
        assignment_status="confirmed",
        anonymous_token="S-abcd1234",
    )
    db_session.add(submission)
    db_session.commit()

    crop_dir = settings.data_dir / "batches" / "test"
    crop_dir.mkdir(parents=True)
    crop_path = crop_dir / "c1.png"
    crop_path.write_bytes(b"png")
    db_session.add(
        ItemResponse(
            submission_id=submission.id,
            item_no=1,
            crop_path=str(crop_path),
        )
    )
    db_session.commit()
    return batch


def _configure_runtime(client):
    assert client.put(
        "/api/settings/api-key",
        json={"api_key": "api-key-secret"},
    ).status_code == 200
    assert client.put(
        "/api/settings/model",
        json={"llm_model": "models/gemini-pro"},
    ).status_code == 200


def _acknowledge(client):
    _configure_runtime(client)
    assert client.put(
        "/api/settings/data-policy",
        json={"acknowledged": True},
    ).status_code == 200


@pytest.fixture
def stub_grading(monkeypatch):
    def fake(*_args, **_kwargs):
        return [
            ScoredItem(
                item_no=1,
                proposed_score=2,
                matched_criterion="정확",
                evidence="선대칭",
                reason="정답 1/1",
                confidence=0.96,
                route="auto",
                recognized_raw="선대칭",
            )
        ]

    monkeypatch.setattr(grading_api, "grade_one_submission", fake)
    monkeypatch.setattr(
        grading_api,
        "build_llm_provider",
        lambda api_key, model, gateway: make_fake_llm_provider(
            responses=[],
            gateway=gateway,
        )[0],
    )


def test_grading_blocked_without_policy_acknowledgement(
    client,
    ready_batch,
    credential_store,
    stub_grading,
):
    _configure_runtime(client)
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 403
    assert "데이터" in response.json()["detail"]


def test_grading_blocked_when_policy_revoked(
    client,
    ready_batch,
    credential_store,
    stub_grading,
):
    _acknowledge(client)
    client.put("/api/settings/data-policy", json={"acknowledged": False})
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 403


def test_grading_blocked_without_api_key(
    client,
    ready_batch,
    credential_store,
    stub_grading,
):
    client.put("/api/settings/data-policy", json={"acknowledged": True})
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 400
    assert "API 키" in response.json()["detail"]


def test_grading_requires_confirmed_rubric(
    client,
    ready_batch,
    credential_store,
    stub_grading,
    db_session,
):
    _acknowledge(client)
    from app.models.rubric import RubricDraft

    draft = db_session.query(RubricDraft).one()
    draft.confirmed = False
    db_session.commit()
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 400
    assert "확정" in response.json()["detail"]


def test_grading_requires_ready_batch(
    client,
    ready_batch,
    credential_store,
    stub_grading,
    db_session,
):
    _acknowledge(client)
    ready_batch.status = "split_failed"
    ready_batch.failure_reason = "스캔 오류"
    db_session.commit()
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 400
    assert "스캔" in response.json()["detail"]


def test_run_creates_scores(
    client,
    ready_batch,
    credential_store,
    stub_grading,
    db_session,
):
    _acknowledge(client)
    response = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert response.status_code == 201
    run_id = response.json()["id"]
    grading_api.execute_run(db_session, run_id, credential_store)
    run = db_session.get(GradingRun, run_id)
    assert run.status == "succeeded"
    assert db_session.query(ItemScore).filter_by(run_id=run_id).count() == 1


def test_run_summary_and_scores(
    client,
    ready_batch,
    credential_store,
    stub_grading,
    db_session,
):
    _acknowledge(client)
    run_id = client.post(
        "/api/grading/runs",
        json={"batch_id": ready_batch.id},
    ).json()["id"]
    grading_api.execute_run(db_session, run_id, credential_store)
    body = client.get(f"/api/grading/runs/{run_id}").json()
    assert body["status"] == "succeeded"
    assert body["auto_count"] == 1
    assert body["manual_count"] == 0
    assert body["total_count"] == 1
    scores = client.get(f"/api/grading/runs/{run_id}/scores").json()["scores"]
    assert scores[0]["evidence"] == "선대칭"
    assert scores[0]["matched_criterion"] == "정확"
    assert scores[0]["student_name"] == "김미래"


def test_policy_revocation_before_worker_starts_fails_run(
    client,
    ready_batch,
    credential_store,
    stub_grading,
    db_session,
):
    _acknowledge(client)
    run_id = client.post(
        "/api/grading/runs",
        json={"batch_id": ready_batch.id},
    ).json()["id"]
    client.put("/api/settings/data-policy", json={"acknowledged": False})
    with pytest.raises(RuntimeError, match="채점 실행"):
        grading_api.execute_run(db_session, run_id, credential_store)
    assert db_session.get(GradingRun, run_id).status == "failed"
    assert db_session.query(ItemScore).filter_by(run_id=run_id).count() == 0


def test_unsafe_crop_path_fails_without_scores(
    client,
    ready_batch,
    credential_store,
    stub_grading,
    db_session,
):
    _acknowledge(client)
    response = db_session.query(ItemResponse).one()
    response.crop_path = "/tmp/outside.png"
    db_session.commit()
    run_id = client.post(
        "/api/grading/runs",
        json={"batch_id": ready_batch.id},
    ).json()["id"]
    with pytest.raises(RuntimeError, match="채점 실행"):
        grading_api.execute_run(db_session, run_id, credential_store)
    assert db_session.get(GradingRun, run_id).status == "failed"
    assert db_session.query(ItemScore).filter_by(run_id=run_id).count() == 0


def test_second_active_run_is_rejected(
    client,
    ready_batch,
    credential_store,
    stub_grading,
):
    _acknowledge(client)
    first = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    second = client.post("/api/grading/runs", json={"batch_id": ready_batch.id})
    assert first.status_code == 201
    assert second.status_code == 409


def test_invalid_threshold_and_extra_field_are_rejected(
    client,
    ready_batch,
    credential_store,
    stub_grading,
):
    _acknowledge(client)
    assert client.post(
        "/api/grading/runs",
        json={"batch_id": ready_batch.id, "confidence_threshold": 1.2},
    ).status_code == 422
    assert client.post(
        "/api/grading/runs",
        json={"batch_id": ready_batch.id, "unexpected": True},
    ).status_code == 422


def test_missing_run_and_scores_return_404(client):
    assert client.get("/api/grading/runs/999").status_code == 404
    assert client.get("/api/grading/runs/999/scores").status_code == 404
