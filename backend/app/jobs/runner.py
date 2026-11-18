"""스레드 풀에서 지역 뒤 작업을 실행하고 진행 상태를 저장한다."""

import json
import math
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import RLock
from typing import Any

from sqlalchemy.orm import Session

from app.models.job import Job


ProgressFn = Callable[[int, int, str], None]
JobHandler = Callable[[dict[str, Any], ProgressFn], dict[str, Any]]

_JOB_TYPE = re.compile(r"[a-z][a-z0-9_]{0,49}", re.ASCII)
_FAILED_DETAIL = "작업 실행 중 오류가 발생했습니다."


def _is_json_value(value: Any) -> bool:
    if value is None or type(value) in {str, bool, int}:
        return True
    if type(value) is float:
        return math.isfinite(value)
    if type(value) is list:
        return all(_is_json_value(item) for item in value)
    if type(value) is dict:
        return all(
            type(key) is str and _is_json_value(item)
            for key, item in value.items()
        )
    return False


def _clone_json_object(value: Any, label: str) -> dict[str, Any]:
    if type(value) is not dict or not _is_json_value(value):
        raise ValueError(f"{label}은 JSON 객체여야 합니다.")
    return json.loads(
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    )


class JobRunner:
    """각 작업에 독립 세션을 주는 단일 프로세스 작업 실행기."""

    def __init__(
        self,
        session_factory: Callable[[], Session],
        max_workers: int = 1,
    ) -> None:
        if type(max_workers) is not int or max_workers < 1:
            raise ValueError("작업 스레드 수는 하나 이상이어야 합니다.")
        self._session_factory = session_factory
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="essay-grader-job",
        )
        self._state_lock = RLock()
        self._closed = False

    def submit(
        self,
        job_type: str,
        payload: dict[str, Any],
        handler: JobHandler,
    ) -> int:
        if type(job_type) is not str or not _JOB_TYPE.fullmatch(job_type):
            raise ValueError("작업 종류 형식이 올바르지 않습니다.")
        if not callable(handler):
            raise TypeError("작업 실행 함수가 필요합니다.")
        checked_payload = _clone_json_object(payload, "작업 입력")

        with self._state_lock:
            if self._closed:
                raise RuntimeError("종료된 작업 실행기에는 제출할 수 없습니다.")
            with self._session_factory() as session:
                job = Job(
                    job_type=job_type,
                    payload=checked_payload,
                    status="pending",
                )
                session.add(job)
                session.commit()
                job_id = job.id
            try:
                self._executor.submit(
                    self._run,
                    job_id,
                    checked_payload,
                    handler,
                )
            except RuntimeError:
                self._mark_schedule_failure(job_id)
                raise RuntimeError("작업 실행을 예약하지 못했습니다.") from None
            return job_id

    def _mark_schedule_failure(self, job_id: int) -> None:
        with self._session_factory() as session:
            job = session.get(Job, job_id)
            if job is not None:
                job.status = "failed"
                job.error = _FAILED_DETAIL
                session.commit()

    def _run(
        self,
        job_id: int,
        payload: dict[str, Any],
        handler: JobHandler,
    ) -> None:
        with self._session_factory() as session:
            job = session.get(Job, job_id)
            if job is None:
                return
            job.status = "running"
            session.commit()

            last_done = 0
            reported_total: int | None = None

            def progress(done: int, total: int, message: str) -> None:
                nonlocal last_done, reported_total
                if (
                    type(done) is not int
                    or type(total) is not int
                    or done < 0
                    or total < 0
                    or done > total
                    or done < last_done
                ):
                    raise ValueError("작업 진행률 범위가 올바르지 않습니다.")
                if reported_total is not None and total != reported_total:
                    raise ValueError("작업 전체 진행량을 바꿀 수 없습니다.")
                if type(message) is not str or len(message) > 200:
                    raise ValueError("작업 진행 문구가 올바르지 않습니다.")
                reported_total = total
                last_done = done
                job.progress_done = done
                job.progress_total = total
                job.progress_message = message
                session.commit()

            try:
                result = handler(_clone_json_object(payload, "작업 입력"), progress)
                checked_result = _clone_json_object(result, "작업 결과")
            except BaseException:
                session.rollback()
                job = session.get(Job, job_id)
                if job is None:
                    return
                job.status = "failed"
                job.result = None
                job.error = _FAILED_DETAIL
            else:
                job.status = "succeeded"
                job.result = checked_result
                job.error = None
            session.commit()

    def shutdown(self) -> None:
        with self._state_lock:
            self._closed = True
        self._executor.shutdown(wait=True)
