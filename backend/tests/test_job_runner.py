import time
from threading import Event

import pytest
from sqlalchemy import func, select

from app.jobs.runner import JobRunner
from app.models.job import Job


def _wait_until_terminal(session_factory, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with session_factory() as session:
            job = session.get(Job, job_id)
            assert job is not None
            if job.status in {"succeeded", "failed"}:
                session.expunge(job)
                return job
        time.sleep(0.01)
    raise AssertionError("작업이 제한 시간 안에 끝나지 않았습니다.")


def test_successful_job_stores_result(session_factory):
    runner = JobRunner(session_factory=session_factory)
    try:
        job_id = runner.submit(
            "scan",
            {"x": 1},
            lambda payload, _progress: {"doubled": payload["x"] * 2},
        )

        job = _wait_until_terminal(session_factory, job_id)

        assert job.status == "succeeded"
        assert job.result == {"doubled": 2}
        assert job.error is None
    finally:
        runner.shutdown()


def test_failed_job_stores_fixed_error_without_exception_content(session_factory):
    runner = JobRunner(session_factory=session_factory)

    def fail(_payload, _progress):
        raise RuntimeError("private-path-marker")

    try:
        job_id = runner.submit("scan", {}, fail)
        job = _wait_until_terminal(session_factory, job_id)

        assert job.status == "failed"
        assert job.error == "작업 실행 중 오류가 발생했습니다."
        assert "private-path-marker" not in job.error
        assert job.result is None
    finally:
        runner.shutdown()


def test_progress_is_recorded(session_factory):
    runner = JobRunner(session_factory=session_factory)

    def handler(_payload, progress):
        progress(3, 10, "3쪽 처리 중")
        progress(10, 10, "처리 완료")
        return {}

    try:
        job = _wait_until_terminal(
            session_factory,
            runner.submit("scan", {}, handler),
        )

        assert job.status == "succeeded"
        assert (job.progress_done, job.progress_total) == (10, 10)
        assert job.progress_message == "처리 완료"
    finally:
        runner.shutdown()


@pytest.mark.parametrize(
    "update",
    [
        (-1, 10, "음수"),
        (11, 10, "범위 밖"),
        (True, 10, "논리값"),
        (1, 10, "x" * 201),
    ],
)
def test_invalid_progress_fails_job_without_leaking_values(
    session_factory, update
):
    runner = JobRunner(session_factory=session_factory)

    def handler(_payload, progress):
        progress(*update)
        return {}

    try:
        job = _wait_until_terminal(
            session_factory,
            runner.submit("scan", {}, handler),
        )

        assert job.status == "failed"
        assert job.error == "작업 실행 중 오류가 발생했습니다."
        assert update[2] not in job.error
    finally:
        runner.shutdown()


def test_progress_cannot_move_backwards_or_change_total(session_factory):
    runner = JobRunner(session_factory=session_factory)

    def handler(_payload, progress):
        progress(5, 10, "절반")
        progress(4, 10, "뒤로 감")
        return {}

    try:
        job = _wait_until_terminal(
            session_factory,
            runner.submit("scan", {}, handler),
        )
        assert job.status == "failed"
        assert (job.progress_done, job.progress_total) == (5, 10)
    finally:
        runner.shutdown()


def test_non_object_result_fails_job(session_factory):
    runner = JobRunner(session_factory=session_factory)
    try:
        job = _wait_until_terminal(
            session_factory,
            runner.submit("scan", {}, lambda *_: ["not", "an", "object"]),
        )
        assert job.status == "failed"
        assert job.result is None
    finally:
        runner.shutdown()


@pytest.mark.parametrize(
    "job_type",
    ["", " ", "Scan", "scan-batch", "x" * 51],
)
def test_invalid_job_type_is_rejected_before_database_write(
    session_factory, job_type
):
    runner = JobRunner(session_factory=session_factory)
    try:
        with pytest.raises(ValueError):
            runner.submit(job_type, {}, lambda *_: {})
        with session_factory() as session:
            assert session.scalar(select(func.count()).select_from(Job)) == 0
    finally:
        runner.shutdown()


def test_payload_must_be_a_json_object(session_factory):
    runner = JobRunner(session_factory=session_factory)
    try:
        with pytest.raises(ValueError):
            runner.submit("scan", {"bad": object()}, lambda *_: {})
        with session_factory() as session:
            assert session.scalar(select(func.count()).select_from(Job)) == 0
    finally:
        runner.shutdown()


def test_shutdown_waits_for_running_job_and_rejects_new_submit(session_factory):
    runner = JobRunner(session_factory=session_factory)
    started = Event()
    release = Event()

    def handler(_payload, _progress):
        started.set()
        assert release.wait(2)
        return {"done": True}

    job_id = runner.submit("scan", {}, handler)
    assert started.wait(2)
    release.set()
    runner.shutdown()

    assert _wait_until_terminal(session_factory, job_id).status == "succeeded"
    with pytest.raises(RuntimeError, match="종료"):
        runner.submit("scan", {}, lambda *_: {})


def test_job_status_api_hides_payload(client, db_session):
    job = Job(
        job_type="scan",
        status="succeeded",
        payload={"private": "payload-marker"},
        result={"count": 2},
        progress_done=2,
        progress_total=2,
        progress_message="완료",
    )
    db_session.add(job)
    db_session.commit()

    response = client.get(f"/api/jobs/{job.id}")

    assert response.status_code == 200
    assert response.json() == {
        "id": job.id,
        "job_type": "scan",
        "status": "succeeded",
        "result": {"count": 2},
        "error": None,
        "progress_done": 2,
        "progress_total": 2,
        "progress_message": "완료",
    }
    assert "payload-marker" not in response.text


def test_missing_job_returns_fixed_404(client):
    response = client.get("/api/jobs/999")

    assert response.status_code == 404
    assert response.json() == {"detail": "작업을 찾을 수 없습니다."}
