from pathlib import Path
import stat

import fitz
import numpy as np
import pytest
from sqlalchemy.exc import SQLAlchemyError

from app.api import scans as scans_api
from app.config import settings
from app.models.classroom import Classroom, Student
from app.models.scan import ItemResponse, PageImage, ScanBatch, Submission
from app.services.scan_pipeline import PipelineOutcome, PipelineResult, StudentResult


def _pdf(page_count: int) -> bytes:
    document = fitz.open()
    for _ in range(page_count):
        document.new_page(width=595, height=842)
    data = document.tobytes()
    document.close()
    return data


@pytest.fixture
def setup_ids(client):
    assessment_id = client.post(
        "/api/assessments",
        json={"title": "평가", "subject": "수학", "grade": 6, "total_points": 20},
    ).json()["id"]
    classroom_id = client.post(
        "/api/classrooms",
        json={
            "name": "6-3",
            "students": [
                {"number": 1, "name": "김미래", "absent": False},
                {"number": 2, "name": "박균형", "absent": False},
            ],
        },
    ).json()["id"]
    uploaded = client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "answer_sheet"},
        files={"file": ("sheet.pdf", _pdf(2), "application/pdf")},
    )
    assert uploaded.status_code == 201
    assert client.post(f"/api/assessments/{assessment_id}/template").status_code == 200
    regions = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={
            "regions": [
                {
                    "region_type": "pii",
                    "item_no": None,
                    "page_no": 1,
                    "x": 50,
                    "y": 50,
                    "width": 400,
                    "height": 60,
                },
                {
                    "region_type": "response",
                    "item_no": 1,
                    "page_no": 1,
                    "x": 60,
                    "y": 200,
                    "width": 400,
                    "height": 100,
                },
                {
                    "region_type": "response",
                    "item_no": 2,
                    "page_no": 2,
                    "x": 60,
                    "y": 200,
                    "width": 400,
                    "height": 100,
                },
            ]
        },
    )
    assert regions.status_code == 200
    return assessment_id, classroom_id


def _student_result(index: int, status: str = "confirmed") -> StudentResult:
    result = StudentResult(index=index, page_range=(index * 2, index * 2 + 2))
    tiny = np.zeros((10, 10), dtype=np.uint8)
    tiny[2:8, 2:8] = 255
    result.aligned_pages = {1: tiny, 2: tiny}
    result.ink_pages = {1: tiny, 2: tiny}
    result.registration_quality = {1: 0.98, 2: 0.96}
    result.crops = {1: tiny, 2: tiny}
    result.ink_crops = {1: tiny, 2: tiny}
    result.assignment_status = status
    result.recognized_name = "김미래" if index == 0 else "박균형"
    result.assignment_note = "교사 확인 필요" if status == "needs_review" else None
    return result


def _batch(db_session, assessment_id, classroom_id, tmp_path) -> ScanBatch:
    batch = ScanBatch(
        assessment_id=assessment_id,
        classroom_id=classroom_id,
        stored_path=str(tmp_path / "scan.pdf"),
        status="processing",
    )
    db_session.add(batch)
    db_session.commit()
    return batch


def test_persist_creates_submissions_private_images_and_crops(
    client,
    setup_ids,
    db_session,
    tmp_path,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    result = PipelineResult(
        PipelineOutcome.OK,
        [_student_result(0), _student_result(1)],
        None,
    )

    scans_api.persist_result(db_session, batch, result, classroom.present_students())

    submissions = db_session.query(Submission).filter_by(batch_id=batch.id).all()
    assert len(submissions) == 2
    assert batch.status == "ready"
    assert db_session.query(ItemResponse).count() == 4
    assert db_session.query(PageImage).count() == 4
    assert len({submission.anonymous_token for submission in submissions}) == 2
    for response in db_session.query(ItemResponse).all():
        path = Path(response.crop_path)
        assert path.is_file()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert path.parent.parent.parent == settings.data_dir / "batches"


def test_persist_sets_needs_review_status(client, setup_ids, db_session, tmp_path) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    result = PipelineResult(
        PipelineOutcome.NEEDS_REVIEW,
        [_student_result(0), _student_result(1, status="needs_review")],
        None,
    )

    scans_api.persist_result(db_session, batch, result, classroom.present_students())

    assert batch.status == "needs_review"


def test_persist_split_failure_creates_nothing(
    client,
    setup_ids,
    db_session,
    tmp_path,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    result = PipelineResult(
        PipelineOutcome.SPLIT_FAILED,
        [],
        "4번째 스캔 페이지에서 쪽 번호가 어긋났습니다.",
    )

    scans_api.persist_result(db_session, batch, result, classroom.present_students())

    assert batch.status == "split_failed"
    assert "4번째" in batch.failure_reason
    assert db_session.query(Submission).filter_by(batch_id=batch.id).count() == 0
    assert not (settings.data_dir / "batches" / str(batch.id)).exists()


def test_persist_rejects_partial_result_without_side_effects(
    client,
    setup_ids,
    db_session,
    tmp_path,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    result = PipelineResult(PipelineOutcome.OK, [_student_result(0)], None)

    with pytest.raises(ValueError, match="파이프라인"):
        scans_api.persist_result(
            db_session,
            batch,
            result,
            classroom.present_students(),
        )

    assert db_session.query(Submission).filter_by(batch_id=batch.id).count() == 0
    assert not (settings.data_dir / "batches" / str(batch.id)).exists()


def test_persist_commit_failure_rolls_back_records_and_files(
    client,
    setup_ids,
    db_session,
    tmp_path,
    monkeypatch,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    original_commit = db_session.commit

    def fail_final_commit():
        if batch.status == "ready":
            raise SQLAlchemyError("private-database-error")
        original_commit()

    monkeypatch.setattr(db_session, "commit", fail_final_commit)

    with pytest.raises(SQLAlchemyError):
        scans_api.persist_result(
            db_session,
            batch,
            PipelineResult(
                PipelineOutcome.OK,
                [_student_result(0), _student_result(1)],
                None,
            ),
            classroom.present_students(),
        )

    assert db_session.query(Submission).filter_by(batch_id=batch.id).count() == 0
    assert not (settings.data_dir / "batches" / str(batch.id)).exists()


@pytest.fixture
def stub_job(monkeypatch):
    submitted: list[dict[str, object]] = []

    class ImmediateRunner:
        def submit(self, job_type, payload, handler):
            assert job_type == "scan_batch"
            assert callable(handler)
            submitted.append(payload)
            return len(submitted)

    monkeypatch.setattr(scans_api, "_runner", ImmediateRunner())
    return submitted


def _upload_scan(client, assessment_id, classroom_id, content):
    return client.post(
        "/api/scans",
        data={"assessment_id": str(assessment_id), "classroom_id": str(classroom_id)},
        files={"file": ("scan.pdf", content, "application/pdf")},
    )


def test_upload_creates_batch_and_submits_job(client, setup_ids, stub_job, db_session) -> None:
    assessment_id, classroom_id = setup_ids
    response = _upload_scan(client, assessment_id, classroom_id, _pdf(4))

    assert response.status_code == 201
    assert response.json()["status"] == "pending"
    assert len(stub_job) == 1
    assert stub_job[0]["batch_id"] == response.json()["id"]
    batch = db_session.get(ScanBatch, response.json()["id"])
    assert Path(batch.stored_path).is_file()
    assert stat.S_IMODE(Path(batch.stored_path).stat().st_mode) == 0o600


def test_invalid_or_wrong_page_count_scan_is_rejected_without_new_file(
    client,
    setup_ids,
    stub_job,
) -> None:
    assessment_id, classroom_id = setup_ids
    before = set(settings.uploads_dir().iterdir())

    invalid = _upload_scan(client, assessment_id, classroom_id, b"not-pdf")
    wrong_count = _upload_scan(client, assessment_id, classroom_id, _pdf(3))

    assert invalid.status_code == 400
    assert wrong_count.status_code == 400
    assert set(settings.uploads_dir().iterdir()) == before
    assert stub_job == []


def test_job_schedule_failure_removes_batch_and_scan_file(
    client,
    setup_ids,
    db_session,
    monkeypatch,
) -> None:
    assessment_id, classroom_id = setup_ids
    before = set(settings.uploads_dir().iterdir())

    class FailedRunner:
        def submit(self, *_args, **_kwargs):
            raise RuntimeError("private-scheduler-error")

    monkeypatch.setattr(scans_api, "_runner", FailedRunner())
    response = _upload_scan(client, assessment_id, classroom_id, _pdf(4))

    assert response.status_code == 500
    assert "private-scheduler-error" not in response.text
    assert db_session.query(ScanBatch).count() == 0
    assert set(settings.uploads_dir().iterdir()) == before


def test_upload_requires_existing_assessment_classroom_and_ready_template(
    client,
    setup_ids,
    stub_job,
) -> None:
    assessment_id, classroom_id = setup_ids
    assert _upload_scan(client, 999, classroom_id, _pdf(4)).status_code == 404
    assert _upload_scan(client, assessment_id, 999, _pdf(4)).status_code == 404

    other = client.post(
        "/api/assessments",
        json={"title": "다른 평가", "subject": "수학", "grade": 6, "total_points": 20},
    ).json()["id"]
    assert _upload_scan(client, other, classroom_id, _pdf(4)).status_code == 400
    assert stub_job == []


def test_batch_status_and_submission_list_report_counts(
    client,
    setup_ids,
    stub_job,
    db_session,
    tmp_path,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    scans_api.persist_result(
        db_session,
        batch,
        PipelineResult(
            PipelineOutcome.NEEDS_REVIEW,
            [_student_result(0), _student_result(1, "needs_review")],
            None,
        ),
        classroom.present_students(),
    )

    status_response = client.get(f"/api/scans/{batch.id}")
    submissions = client.get(f"/api/scans/{batch.id}/submissions")

    assert status_response.json()["submission_count"] == 2
    assert status_response.json()["review_count"] == 1
    assert len(submissions.json()["submissions"]) == 2
    assert "anonymous_token" not in submissions.text


def test_reassign_submission_clears_review(
    client,
    setup_ids,
    stub_job,
    db_session,
    tmp_path,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    first = _student_result(0, "needs_review")
    second = _student_result(1)
    scans_api.persist_result(
        db_session,
        batch,
        PipelineResult(PipelineOutcome.NEEDS_REVIEW, [first, second], None),
        classroom.present_students(),
    )
    submission = db_session.query(Submission).filter_by(batch_id=batch.id).first()

    response = client.post(
        f"/api/scans/{batch.id}/submissions/{submission.id}/reassign",
        json={"student_id": submission.student_id},
    )

    assert response.status_code == 200
    assert response.json()["assignment_status"] == "confirmed"
    assert client.get(f"/api/scans/{batch.id}").json()["status"] == "ready"


def test_reassign_swaps_existing_student_and_rejects_other_classroom(
    client,
    setup_ids,
    stub_job,
    db_session,
    tmp_path,
) -> None:
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)
    scans_api.persist_result(
        db_session,
        batch,
        PipelineResult(
            PipelineOutcome.NEEDS_REVIEW,
            [
                _student_result(0, "needs_review"),
                _student_result(1, "needs_review"),
            ],
            None,
        ),
        classroom.present_students(),
    )
    submissions = db_session.query(Submission).filter_by(batch_id=batch.id).all()
    other_classroom = Classroom(name="다른 반")
    other_classroom.students = [Student(number=1, name="다른학생")]
    db_session.add(other_classroom)
    db_session.commit()

    first_student_id = submissions[0].student_id
    second_student_id = submissions[1].student_id
    swapped = client.post(
        f"/api/scans/{batch.id}/submissions/{submissions[0].id}/reassign",
        json={"student_id": second_student_id},
    )
    db_session.expire_all()
    first_after = db_session.get(Submission, submissions[0].id)
    second_after = db_session.get(Submission, submissions[1].id)
    outside = client.post(
        f"/api/scans/{batch.id}/submissions/{submissions[0].id}/reassign",
        json={"student_id": other_classroom.students[0].id},
    )

    assert swapped.status_code == 200
    assert first_after.student_id == second_student_id
    assert second_after.student_id == first_student_id
    assert first_after.assignment_status == "confirmed"
    assert second_after.assignment_status == "confirmed"
    assert client.get(f"/api/scans/{batch.id}").json()["status"] == "ready"
    assert (
        db_session.query(Student).filter_by(classroom_id=classroom_id).count()
        == 2
    )
    assert outside.status_code == 400


def test_missing_batch_and_submission_return_404(client) -> None:
    assert client.get("/api/scans/999").status_code == 404
    assert client.get("/api/scans/999/submissions").status_code == 404
    assert (
        client.post(
            "/api/scans/999/submissions/999/reassign",
            json={"student_id": 1},
        ).status_code
        == 404
    )
