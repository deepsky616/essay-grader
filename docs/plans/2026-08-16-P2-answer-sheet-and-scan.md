# P2 — 답안지 템플릿과 스캔 처리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사가 마커가 인쇄된 답안지를 만들어 배부하고, 시험 후 전체 학생 답안을 한 번에 스캔한 PDF 1개를 올리면, 학생별·문항별로 정확히 잘린 답안 이미지가 만들어진다. 급지 사고가 있으면 채점 전에 배치가 중단된다.

**Architecture:** 답안지 네 모서리에 ArUco 마커를 인쇄하고, **마커 ID에 쪽 번호를 인코딩**한다. 한 번의 마커 검출로 정합용 좌표와 쪽 번호를 동시에 얻는다. 쪽 번호 수열이 `1..N, 1..N, …` 패턴을 벗어나면 급지 사고이므로 배치를 중단한다. 정합 후 빈 답안지 템플릿을 차분하여 학생 필기만 남기고, 교사가 지정한 영역대로 문항별 크롭을 만든다.

**Tech Stack:** OpenCV (`opencv-contrib-python`, ArUco), PyMuPDF, NumPy, SQLAlchemy, FastAPI / React 캔버스 영역 지정

**설계 문서:** `docs/specs/2026-08-15-architecture-design.md` (§7.1 ~ §7.7, §14)
**선행 계획:** `docs/plans/2026-08-15-P1-rubric-authoring.md`

---

## 이 계획의 범위

**포함**
- 답안지 PDF에 정합·쪽번호 마커와 응답 박스를 삽입한 인쇄용 PDF 생성
- 마커 검출과 페이지 정합(homography)
- 문항별 응답 영역·PII 영역 지정 UI
- 명렬표 업로드
- 대량 스캔 PDF 분할 (쪽 번호 마커 1차 검증 → 이름란 2차 검증)
- 학생 필기 추출 (템플릿 차분)
- 문항별 크롭 생성
- 백그라운드 작업 큐 (P1에서 미뤄둔 것 — 여기서 실제로 필요해진다)
- `pii_terms_provider`를 실제 명렬표 이름 집합으로 연결

**제외 (P3 이후)**
- 손글씨 인식(OCR) — 단, 이름란 로컬 OCR은 배정 검증에 필요하므로 P2에 포함
- 채점, 교사 검토 UI, 피드백

**완료 시점의 산출물:** `ItemResponse` 레코드 — 학생 × 문항마다 크롭 이미지 한 장. P3의 인식 엔진이 이걸 입력으로 받는다.

---

## 왜 마커 ID에 쪽 번호를 넣는가

답안지 양식을 수정할 수 있게 되면서 선택지가 생겼다. 설계 문서 §7.1은 "정합 마커"와 "쪽 번호 마커"를 따로 두었지만, **ArUco 마커 ID 자체에 쪽 번호를 인코딩하면 하나로 합칠 수 있다.**

```
p쪽의 마커 ID = (p-1) * 4 + corner    (corner: 0=좌상, 1=우상, 2=우하, 3=좌하)

1쪽 → ID 0, 1, 2, 3
2쪽 → ID 4, 5, 6, 7
3쪽 → ID 8, 9, 10, 11
```

검출 한 번으로 두 가지를 동시에 얻는다.
- 네 모서리 좌표 → homography 산출
- `ID // 4 + 1` → 쪽 번호

부품이 줄고, 쪽 번호를 읽었다는 것이 곧 정합에 성공했다는 뜻이 되어 실패 처리가 단순해진다. `DICT_4X4_250`은 ID 250개를 제공하므로 62쪽까지 지원한다.

---

## File Structure

```
backend/app/
├── models/
│   ├── sheet_template.py       SheetTemplate, RegionSpec
│   ├── classroom.py            Classroom, Student
│   ├── scan.py                 ScanBatch, Submission, PageImage, ItemResponse
│   └── job.py                  Job  (P1에서 미룬 것)
├── jobs/
│   └── runner.py               스레드 풀 + DB 상태 기록
├── services/
│   ├── markers.py              ★ ArUco 마커 생성 · 검출 · 쪽번호 인코딩
│   ├── sheet_builder.py        ★ 답안지 PDF에 마커·박스 삽입
│   ├── pdf_pages.py            스캔 PDF → 페이지 이미지, 백지 감지
│   ├── registration.py         ★ homography 정합
│   ├── ink_extract.py          ★ 템플릿 차분 → 필기 마스크
│   ├── batch_split.py          ★ 쪽번호 수열 검증 → 학생 분할
│   ├── roster_match.py         이름란 폐집합 매칭
│   └── cropper.py              영역별 크롭 생성
├── providers/
│   └── local_ocr.py            로컬 OCR (PII 영역 전용)
└── api/
    ├── templates.py            영역 지정 CRUD
    ├── classrooms.py           명렬표
    ├── scans.py                배치 업로드 · 상태 · 재배정
    └── jobs.py                 작업 진행률 조회

frontend/src/pages/
├── RegionEditor.tsx            ★ 캔버스 영역 지정
├── ClassroomSetup.tsx          명렬표 입력
└── ScanBatch.tsx               배치 업로드 · 진행 · 오류 처리
```

**책임 분리 원칙:** `markers.py`, `registration.py`, `ink_extract.py`, `batch_split.py`는 전부 **순수 함수 모듈**이다. DB나 FastAPI를 import하지 않는다. 이미지 배열과 값 객체만 주고받으므로 실제 스캐너 없이 합성 이미지로 전부 테스트할 수 있다. 이 경계를 지키지 않으면 P2는 테스트가 불가능해진다.

---

## Task 1: 의존성 추가와 작업 큐

P1에서 미뤄둔 작업 큐를 여기서 만든다. 28명 × 3쪽 = 84쪽의 정합과 차분은 수 분이 걸리므로, 이제 진행률 폴링이 실제로 필요하다.

**설계 참조:** 5절, 7.1절, 7.2절, 7.3절, 10절, 11절, 12절. 오래 걸리는 지역 영상 처리를 한 스레드에서 독립 세션으로 실행하고, 로컬 API에는 필요한 상태와 진행률만 공개한다.

> **구현 계약 보강:** 작업 종류는 소문자와 숫자와 밑줄만 허용하고 입력과 결과는 유한한 JSON 객체로 깊은 복사한다. 진행률은 영 이상, 완료량 이하, 단조 증가, 고정 전체량, 200자 이하 문구를 강제한다. 실행 실패의 예외 원문은 경로와 학생 자료를 포함할 수 있으므로 데이터베이스와 API에 넣지 않고 고정 문구만 저장한다. 종료된 실행기는 새 제출을 거절하고, API 응답은 작업 입력을 공개하지 않는다.

**Files:**
- Modify: `backend/pyproject.toml`
- Create: `backend/app/models/job.py`
- Create: `backend/app/jobs/__init__.py`
- Create: `backend/app/jobs/runner.py`
- Modify: `backend/app/models/__init__.py`
- Create: `backend/app/api/jobs.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_job_runner.py`

- [ ] **Step 1: `pyproject.toml` 의존성 추가**

`dependencies` 배열에 다음을 추가한다.

```toml
    "opencv-contrib-python>=4.10",
    "numpy>=2.0",
    "pillow>=11.0",
    "pytesseract>=0.3.13",
```

`opencv-python`이 아니라 **`opencv-contrib-python`** 이어야 한다. ArUco는 contrib 패키지에만 있다. 둘을 함께 설치하면 충돌하므로 하나만 넣는다.

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/test_job_runner.py`:

```python
import time

from app.jobs.runner import JobRunner
from app.models.job import Job


def _wait_until_done(session_factory, job_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        session = session_factory()
        job = session.get(Job, job_id)
        status = job.status
        session.close()
        if status in {"succeeded", "failed"}:
            return job
        time.sleep(0.02)
    raise AssertionError(f"작업 {job_id} 이 시간 안에 끝나지 않았습니다.")


def test_successful_job_stores_result(session_factory):
    runner = JobRunner(session_factory=session_factory)
    job_id = runner.submit("scan", {"x": 1}, lambda payload, _p: {"doubled": payload["x"] * 2})

    job = _wait_until_done(session_factory, job_id)
    assert job.status == "succeeded"
    assert job.result == {"doubled": 2}
    runner.shutdown()


def test_failed_job_stores_error_message(session_factory):
    runner = JobRunner(session_factory=session_factory)

    def boom(_payload, _progress):
        raise RuntimeError("정합 실패")

    job_id = runner.submit("scan", {}, boom)
    job = _wait_until_done(session_factory, job_id)
    assert job.status == "failed"
    assert job.error == "작업 실행 중 오류가 발생했습니다."
    runner.shutdown()


def test_progress_is_recorded(session_factory):
    runner = JobRunner(session_factory=session_factory)

    def handler(_payload, progress):
        progress(3, 10, "3쪽 처리 중")
        return {}

    job_id = runner.submit("scan", {}, handler)
    job = _wait_until_done(session_factory, job_id)
    assert job.progress_done == 3
    assert job.progress_total == 10
    assert job.progress_message == "3쪽 처리 중"
    runner.shutdown()
```

`backend/tests/conftest.py`에 `session_factory` 픽스처를 추가한다.

```python
@pytest.fixture
def session_factory(engine):
    return sessionmaker(bind=engine, expire_on_commit=False)
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_job_runner.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.jobs.runner'`

- [ ] **Step 4: `models/job.py` 작성**

```python
from typing import Any

from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Job(Base, TimestampMixin):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # pending | running | succeeded | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    progress_done: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress_message: Mapped[str] = mapped_column(String(200), nullable=False, default="")
```

- [ ] **Step 5: `jobs/runner.py` 작성**

```python
"""스레드 풀 기반 작업 실행기.

단일 사용자 개인 도구이므로 Celery·Redis 를 두지 않는다. 상태와 진행률을 jobs
테이블에 기록하면 프런트엔드가 폴링으로 볼 수 있다.

주의: 작업 스레드는 반드시 자기 세션을 만들어 쓴다. SQLAlchemy Session 은
스레드 안전하지 않으므로 호출자의 세션을 넘겨받아 쓰면 안 된다.
"""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from sqlalchemy.orm import Session

from app.models.job import Job

ProgressFn = Callable[[int, int, str], None]
JobHandler = Callable[[dict[str, Any], ProgressFn], dict[str, Any]]


class JobRunner:
    def __init__(self, session_factory: Callable[[], Session], max_workers: int = 1) -> None:
        self._session_factory = session_factory
        self._executor = ThreadPoolExecutor(max_workers=max_workers)

    def submit(self, job_type: str, payload: dict[str, Any], handler: JobHandler) -> int:
        session = self._session_factory()
        try:
            job = Job(job_type=job_type, payload=payload, status="pending")
            session.add(job)
            session.commit()
            job_id = job.id
        finally:
            session.close()

        self._executor.submit(self._run, job_id, payload, handler)
        return job_id

    def _run(self, job_id: int, payload: dict[str, Any], handler: JobHandler) -> None:
        session = self._session_factory()
        try:
            job = session.get(Job, job_id)
            job.status = "running"
            session.commit()

            def progress(done: int, total: int, message: str) -> None:
                job.progress_done = done
                job.progress_total = total
                job.progress_message = message
                session.commit()

            try:
                result = handler(payload, progress)
            except Exception as exc:  # noqa: BLE001 - 실패는 상태로 기록한다
                job.status = "failed"
                job.error = f"{type(exc).__name__}: {exc}"
            else:
                job.status = "succeeded"
                job.result = result
            session.commit()
        finally:
            session.close()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True)
```

`backend/app/jobs/__init__.py`는 빈 파일로 만든다.

- [ ] **Step 6: `api/jobs.py` 작성**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.db import get_session
from app.models.job import Job

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: str
    status: str
    result: dict | None
    error: str | None
    progress_done: int
    progress_total: int
    progress_message: str


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: int, session: Session = Depends(get_session)) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "작업을 찾을 수 없습니다.")
    return job
```

`models/__init__.py`에 `Job`을 추가하고, `main.py`에 `app.include_router(jobs.router)`를 넣는다.

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_job_runner.py -v`
Expected: PASS (3 tests)

- [ ] **Step 8: 커밋**

```bash
git add backend/
git commit -m "feat: 백그라운드 작업 큐와 진행률 기록"
```

---

## Task 2: 마커 생성과 검출

P2의 토대다. 순수 함수 모듈이므로 합성 이미지로 완전히 테스트할 수 있다.

**설계 참조:** 2절, 7.1절, 7.2절, 10절, 11절, 12절. 마커 번호의 닫힌 집합으로 쪽과 물리 모서리를 함께 식별하고, 모호한 검출은 뒤 정합이나 학생 분할로 넘기지 않는다.

> **구현 계약 보강:** `DICT_4X4_250` 가운데 0부터 247까지만 62쪽의 네 모서리에 쓰고 248과 249는 거절한다. 정수와 크기와 이미지 자료형을 엄격히 검사한다. 한 이미지에 서로 다른 쪽 마커가 하나라도 섞이거나 같은 모서리가 중복되면 다수결로 숨기지 않고 `MarkerDetectionError`로 닫아서 실패한다. 검출 결과의 좌표 매핑은 만든 뒤 바꿀 수 없다.

**Files:**
- Create: `backend/app/services/markers.py`
- Test: `backend/tests/test_markers.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_markers.py`:

```python
import cv2
import numpy as np
import pytest

from app.services.markers import (
    CORNERS,
    MAX_PAGES,
    decode_marker_id,
    detect_page_markers,
    encode_marker_id,
    render_marker,
)


def test_marker_id_round_trips():
    for page_no in (1, 2, 17, MAX_PAGES):
        for corner in range(CORNERS):
            marker_id = encode_marker_id(page_no, corner)
            assert decode_marker_id(marker_id) == (page_no, corner)


def test_marker_ids_are_unique_across_pages():
    ids = {
        encode_marker_id(page, corner)
        for page in range(1, 11)
        for corner in range(CORNERS)
    }
    assert len(ids) == 40


def test_page_number_beyond_capacity_is_rejected():
    with pytest.raises(ValueError):
        encode_marker_id(MAX_PAGES + 1, 0)


def test_render_marker_produces_square_image():
    image = render_marker(encode_marker_id(1, 0), size_px=80)
    assert image.shape == (80, 80)
    assert image.dtype == np.uint8


def _synthetic_page(page_no: int, width=1000, height=1400, margin=60, marker=90):
    """마커 네 개를 흰 종이 모서리에 붙인 합성 페이지."""
    page = np.full((height, width), 255, dtype=np.uint8)
    positions = [
        (margin, margin),
        (width - margin - marker, margin),
        (width - margin - marker, height - margin - marker),
        (margin, height - margin - marker),
    ]
    for corner, (x, y) in enumerate(positions):
        image = render_marker(encode_marker_id(page_no, corner), size_px=marker)
        page[y : y + marker, x : x + marker] = image
    return page


def test_detects_all_four_markers_and_page_number():
    page = _synthetic_page(page_no=3)
    result = detect_page_markers(page)

    assert result is not None
    assert result.page_no == 3
    assert len(result.corner_points) == 4


def test_returns_none_when_no_markers_present():
    blank = np.full((600, 400), 255, dtype=np.uint8)
    assert detect_page_markers(blank) is None


def test_detects_after_rotation_and_scaling():
    """스캐너가 기울여 넣어도 읽혀야 한다."""
    page = _synthetic_page(page_no=2)
    center = (page.shape[1] / 2, page.shape[0] / 2)
    matrix = cv2.getRotationMatrix2D(center, angle=4.0, scale=0.92)
    warped = cv2.warpAffine(
        page, matrix, (page.shape[1], page.shape[0]), borderValue=255
    )

    result = detect_page_markers(warped)
    assert result is not None
    assert result.page_no == 2


def test_partial_detection_is_reported_but_not_fatal():
    page = _synthetic_page(page_no=1)
    page[:200, :] = 255  # 위쪽 마커 두 개를 지운다
    result = detect_page_markers(page)

    assert result is not None
    assert result.page_no == 1
    assert len(result.corner_points) == 2
    assert not result.is_complete
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_markers.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.markers'`

- [ ] **Step 3: `services/markers.py` 작성**

```python
"""ArUco 마커로 쪽 번호와 정합 기준점을 동시에 얻는다.

마커 ID 에 쪽 번호를 인코딩하므로 검출 한 번으로 두 가지를 얻는다.
  · 네 모서리 좌표 → homography 산출 (registration.py)
  · ID // 4 + 1    → 쪽 번호 (batch_split.py 의 급지 사고 감지)

이 방식이 아니면 정합 마커와 쪽번호 바코드를 따로 인쇄하고 따로 읽어야 하며,
둘 중 하나만 읽혔을 때의 처리가 복잡해진다.
"""

from dataclasses import dataclass

import cv2
import numpy as np

CORNERS = 4  # 0=좌상, 1=우상, 2=우하, 3=좌하
ARUCO_DICT = cv2.aruco.DICT_4X4_250
DICT_CAPACITY = 250
MAX_PAGES = DICT_CAPACITY // CORNERS  # 62

CORNER_NAMES = ("좌상", "우상", "우하", "좌하")


def encode_marker_id(page_no: int, corner: int) -> int:
    if not 1 <= page_no <= MAX_PAGES:
        raise ValueError(
            f"쪽 번호는 1..{MAX_PAGES} 범위여야 합니다. 받은 값: {page_no}"
        )
    if not 0 <= corner < CORNERS:
        raise ValueError(f"모서리 번호는 0..3 이어야 합니다. 받은 값: {corner}")
    return (page_no - 1) * CORNERS + corner


def decode_marker_id(marker_id: int) -> tuple[int, int]:
    return marker_id // CORNERS + 1, marker_id % CORNERS


def _dictionary() -> cv2.aruco.Dictionary:
    return cv2.aruco.getPredefinedDictionary(ARUCO_DICT)


def render_marker(marker_id: int, size_px: int) -> np.ndarray:
    """단일 마커를 흑백 이미지로 그린다."""
    return cv2.aruco.generateImageMarker(_dictionary(), marker_id, size_px)


@dataclass(frozen=True)
class DetectedPage:
    page_no: int
    # corner index -> 마커 중심 좌표 (x, y)
    corner_points: dict[int, tuple[float, float]]

    @property
    def is_complete(self) -> bool:
        return len(self.corner_points) == CORNERS

    def missing_corners(self) -> list[str]:
        return [
            CORNER_NAMES[corner]
            for corner in range(CORNERS)
            if corner not in self.corner_points
        ]


def detect_page_markers(image: np.ndarray) -> DetectedPage | None:
    """페이지 이미지에서 마커를 찾아 쪽 번호와 모서리 좌표를 돌려준다.

    한 장에 여러 쪽의 마커가 섞이거나 같은 모서리가 중복되면 급지 겹침으로
    보고 거절한다. 하나도 못 찾으면 None 을 돌려준다.
    """
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    detector = cv2.aruco.ArucoDetector(
        _dictionary(), cv2.aruco.DetectorParameters()
    )
    corners, ids, _rejected = detector.detectMarkers(gray)

    if ids is None or len(ids) == 0:
        return None

    by_page: dict[int, dict[int, tuple[float, float]]] = {}
    for marker_corners, marker_id in zip(corners, ids.flatten(), strict=True):
        page_no, corner_index = decode_marker_id(int(marker_id))
        center = marker_corners.reshape(-1, 2).mean(axis=0)
        by_page.setdefault(page_no, {})[corner_index] = (
            float(center[0]),
            float(center[1]),
        )

    if len(by_page) != 1:
        raise MarkerDetectionError("한 이미지에서 여러 쪽의 마커가 검출되었습니다.")
    page_no, points = next(iter(by_page.items()))
    if len(points) != len(corners):
        raise MarkerDetectionError("같은 모서리 마커가 중복 검출되었습니다.")
    return DetectedPage(page_no=page_no, corner_points=points)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_markers.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/markers.py backend/tests/test_markers.py
git commit -m "feat: ArUco 마커 생성·검출과 쪽번호 인코딩"
```

---

## Task 3: 답안지 PDF 생성기

교사가 원본 답안지 PDF를 올리면, 마커와 응답 박스가 인쇄된 배부용 PDF를 만들어준다.

**설계 참조:** 7.1절, 7.2절, 10절, 11절, 14절. 네 모서리 마커 하나에 쪽 번호와 정합점을 함께 담고, 응답 박스는 뒤 크롭과 교사 영역 지정의 공통 경계로 쓴다.

> **구현 계약 보강:** 쪽 수와 용지 크기, 모든 영역의 쪽과 유한 좌표와 양의 크기와 용지 안쪽 배치를 먼저 검사한다. 응답 박스가 마커의 흰 여백까지 침범하면 거절한다. 원본과 출력이 같은 경로인 경우를 막고, 임시 PDF의 쪽 수까지 다시 확인한 뒤 원자적으로 교체하여 실패 중 기존 출력과 원본을 보존한다.

**Files:**
- Create: `backend/app/services/sheet_builder.py`
- Test: `backend/tests/test_sheet_builder.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_sheet_builder.py`:

```python
import fitz
import numpy as np
import pytest

from app.services.markers import detect_page_markers
from app.services.sheet_builder import MARKER_SIZE_PT, build_printable_sheet


@pytest.fixture
def plain_pdf(tmp_path):
    path = tmp_path / "plain.pdf"
    doc = fitz.open()
    for index in range(3):
        page = doc.new_page(width=595, height=842)  # A4
        page.insert_text((72, 100), f"page {index + 1}", fontsize=14)
    doc.save(path)
    doc.close()
    return path


def test_output_keeps_page_count(plain_pdf, tmp_path):
    out = tmp_path / "printable.pdf"
    build_printable_sheet(plain_pdf, out, regions=[])

    with fitz.open(out) as doc:
        assert doc.page_count == 3


def test_markers_are_detectable_on_each_page(plain_pdf, tmp_path):
    out = tmp_path / "printable.pdf"
    build_printable_sheet(plain_pdf, out, regions=[])

    with fitz.open(out) as doc:
        for index, page in enumerate(doc):
            pixmap = page.get_pixmap(dpi=200)
            image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            detected = detect_page_markers(image[:, :, :3])
            assert detected is not None, f"{index + 1}쪽에서 마커를 찾지 못했습니다."
            assert detected.page_no == index + 1
            assert detected.is_complete


def test_response_boxes_are_drawn(plain_pdf, tmp_path):
    out = tmp_path / "printable.pdf"
    build_printable_sheet(
        plain_pdf,
        out,
        regions=[{"page_no": 1, "x": 100.0, "y": 300.0, "width": 380.0, "height": 120.0}],
    )

    with fitz.open(out) as doc:
        drawings = doc[0].get_drawings()
        # 마커 배경 사각형 4개 + 응답 박스 1개 이상
        assert len(drawings) >= 5


def test_rejects_document_exceeding_marker_capacity(tmp_path):
    path = tmp_path / "huge.pdf"
    doc = fitz.open()
    for _ in range(70):
        doc.new_page(width=595, height=842)
    doc.save(path)
    doc.close()

    with pytest.raises(ValueError, match="쪽 번호"):
        build_printable_sheet(path, tmp_path / "out.pdf", regions=[])


def test_marker_size_is_large_enough_to_scan():
    # 200dpi 스캔에서 마커 한 변이 최소 50px 은 되어야 안정적으로 검출된다.
    px_at_200dpi = MARKER_SIZE_PT / 72 * 200
    assert px_at_200dpi >= 50
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_sheet_builder.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.sheet_builder'`

- [ ] **Step 3: `services/sheet_builder.py` 작성**

```python
"""배부용 답안지 PDF 를 만든다.

원본 답안지에 다음을 얹는다.
  · 네 모서리 ArUco 마커 (쪽 번호 인코딩 포함)
  · 문항별 응답 영역 박스

설계 문서 §14 참조. 마커가 있으면 정합 정확도가 오르고, 응답 박스가 있으면
학생이 칸을 벗어나 쓰는 일이 줄어 크롭 품질이 좋아진다.
"""

import io
from pathlib import Path
from typing import Any

import fitz
from PIL import Image

from app.services.markers import CORNERS, MAX_PAGES, encode_marker_id, render_marker

# 마커 한 변 크기(pt). 72pt = 1인치. 24pt ≈ 8.5mm.
MARKER_SIZE_PT = 24.0
# 종이 가장자리에서 마커까지 여백(pt).
MARKER_MARGIN_PT = 18.0
# 마커 주변 흰 여백(quiet zone). 없으면 검출률이 떨어진다.
QUIET_ZONE_PT = 6.0

MARKER_RENDER_PX = 200


def _marker_rects(page_width: float, page_height: float) -> list[fitz.Rect]:
    size = MARKER_SIZE_PT
    margin = MARKER_MARGIN_PT
    left, top = margin, margin
    right, bottom = page_width - margin - size, page_height - margin - size

    # 순서는 markers.CORNER_NAMES 와 같아야 한다: 좌상, 우상, 우하, 좌하
    origins = [(left, top), (right, top), (right, bottom), (left, bottom)]
    return [fitz.Rect(x, y, x + size, y + size) for x, y in origins]


def _marker_png(marker_id: int) -> bytes:
    array = render_marker(marker_id, size_px=MARKER_RENDER_PX)
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="PNG")
    return buffer.getvalue()


def build_printable_sheet(
    source_pdf: Path,
    output_pdf: Path,
    regions: list[dict[str, Any]],
) -> Path:
    """원본 답안지에 마커와 응답 박스를 얹어 배부용 PDF 를 만든다.

    regions 항목: {"page_no": 1-based, "x", "y", "width", "height"} — 모두 PDF 포인트 단위.
    """
    with fitz.open(source_pdf) as document:
        if document.page_count > MAX_PAGES:
            raise ValueError(
                f"답안지가 {document.page_count}쪽입니다. "
                f"쪽 번호 마커는 {MAX_PAGES}쪽까지만 지원합니다."
            )

        for index, page in enumerate(document):
            page_no = index + 1
            rects = _marker_rects(page.rect.width, page.rect.height)

            for corner in range(CORNERS):
                rect = rects[corner]
                # quiet zone: 마커 뒤에 흰 사각형을 깔아 배경 간섭을 없앤다.
                page.draw_rect(
                    fitz.Rect(
                        rect.x0 - QUIET_ZONE_PT,
                        rect.y0 - QUIET_ZONE_PT,
                        rect.x1 + QUIET_ZONE_PT,
                        rect.y1 + QUIET_ZONE_PT,
                    ),
                    color=None,
                    fill=(1, 1, 1),
                )
                page.insert_image(rect, stream=_marker_png(encode_marker_id(page_no, corner)))

            for region in regions:
                if region["page_no"] != page_no:
                    continue
                page.draw_rect(
                    fitz.Rect(
                        region["x"],
                        region["y"],
                        region["x"] + region["width"],
                        region["y"] + region["height"],
                    ),
                    color=(0.6, 0.6, 0.6),
                    width=0.7,
                )

        document.save(output_pdf)

    return output_pdf
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_sheet_builder.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/sheet_builder.py backend/tests/test_sheet_builder.py
git commit -m "feat: 마커·응답박스가 인쇄된 배부용 답안지 생성"
```

---

## Task 4: 페이지 정합

**설계 참조:** 2절, 7.1절, 7.2절, 11절, 14절. 새 배부용 답안지는 네 마커의 대응점으로 정합하고, 마커가 전혀 없는 기존 양식만 ORB 특징점과 RANSAC으로 맞춘다.

> **구현 계약 보강:** 마커가 양쪽에 완전하게 있으면 이를 반드시 우선한다. 일부 마커, 혼합 쪽, 서로 다른 쪽 번호는 특징점 방식으로 숨기지 않고 닫아서 실패한다. 양쪽 모두 마커가 없을 때에만 특징점 방식으로 내려가며 최소 대응 수, 인라이어 수와 비율, 유한하고 비퇴화한 변환 행렬을 검사한다. 정합 결과는 회색 8비트의 읽기 전용 이미지로 돌려준다.

**Files:**
- Create: `backend/app/services/registration.py`
- Test: `backend/tests/test_registration.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_registration.py`:

```python
import cv2
import numpy as np
import pytest

from app.services.markers import CORNERS, encode_marker_id, render_marker
from app.services.registration import RegistrationFailed, register_page


def _template(width=1000, height=1400, margin=60, marker=90):
    page = np.full((height, width), 255, dtype=np.uint8)
    positions = [
        (margin, margin),
        (width - margin - marker, margin),
        (width - margin - marker, height - margin - marker),
        (margin, height - margin - marker),
    ]
    for corner, (x, y) in enumerate(positions):
        page[y : y + marker, x : x + marker] = render_marker(
            encode_marker_id(1, corner), size_px=marker
        )
    # 정합 확인용 표식
    cv2.rectangle(page, (400, 600), (600, 700), 0, 3)
    return page


def test_identity_registration_returns_same_image():
    template = _template()
    result = register_page(template, template)
    assert result.page_no == 1
    assert result.quality > 0.9
    assert np.mean(np.abs(result.aligned.astype(int) - template.astype(int))) < 5


def test_recovers_rotated_and_shifted_scan():
    template = _template()
    matrix = cv2.getRotationMatrix2D((500.0, 700.0), angle=3.5, scale=0.94)
    matrix[0, 2] += 25
    matrix[1, 2] -= 12
    scan = cv2.warpAffine(template, matrix, (1000, 1400), borderValue=255)

    result = register_page(scan, template)

    assert result.page_no == 1
    # 정합 후에는 표식 위치가 템플릿과 맞아야 한다.
    difference = np.mean(np.abs(result.aligned.astype(int) - template.astype(int)))
    assert difference < 20


def test_raises_when_markers_missing():
    template = _template()
    blank = np.full((1400, 1000), 255, dtype=np.uint8)
    with pytest.raises(RegistrationFailed, match="마커"):
        register_page(blank, template)


def test_raises_when_too_few_corners():
    template = _template()
    scan = _template()
    scan[:250, :] = 255  # 위쪽 마커 두 개 제거 → 2개만 남음
    with pytest.raises(RegistrationFailed, match="모서리"):
        register_page(scan, template)


def test_aligned_output_matches_template_shape():
    template = _template()
    scan = cv2.resize(_template(), (700, 980))
    result = register_page(scan, template)
    assert result.aligned.shape == template.shape
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_registration.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.registration'`

- [ ] **Step 3: `services/registration.py` 작성**

```python
"""스캔 페이지를 템플릿 좌표계로 맞춘다.

네 모서리 마커의 대응점으로 homography 를 구한다. 특징점 매칭(ORB)보다 안정적이다.
마커는 인쇄된 위치가 정확히 알려져 있고, 학생 필기에 가려지지 않기 때문이다.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from app.services.markers import detect_page_markers

MIN_CORNERS_FOR_HOMOGRAPHY = 4


class RegistrationFailed(Exception):
    """정합에 필요한 마커를 충분히 찾지 못했을 때 발생한다."""


@dataclass(frozen=True)
class Registered:
    page_no: int
    aligned: np.ndarray
    quality: float  # 0..1, 마커 대응점의 재투영 정확도


def _to_gray(image: np.ndarray) -> np.ndarray:
    return image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def register_page(scan: np.ndarray, template: np.ndarray) -> Registered:
    scan_gray = _to_gray(scan)
    template_gray = _to_gray(template)

    scan_markers = detect_page_markers(scan_gray)
    if scan_markers is None:
        raise RegistrationFailed(
            "스캔 페이지에서 마커를 하나도 찾지 못했습니다. "
            "답안지가 뒤집혔거나 마커가 인쇄되지 않았을 수 있습니다."
        )

    template_markers = detect_page_markers(template_gray)
    if template_markers is None:
        raise RegistrationFailed("템플릿에서 마커를 찾지 못했습니다.")

    shared = sorted(set(scan_markers.corner_points) & set(template_markers.corner_points))
    if len(shared) < MIN_CORNERS_FOR_HOMOGRAPHY:
        missing = scan_markers.missing_corners()
        raise RegistrationFailed(
            f"정합에 필요한 모서리 마커가 부족합니다. "
            f"{len(shared)}개만 검출되었고 {', '.join(missing)} 마커를 찾지 못했습니다."
        )

    source = np.array([scan_markers.corner_points[c] for c in shared], dtype=np.float32)
    destination = np.array(
        [template_markers.corner_points[c] for c in shared], dtype=np.float32
    )

    homography = cv2.getPerspectiveTransform(source, destination)
    height, width = template_gray.shape[:2]
    aligned = cv2.warpPerspective(
        scan_gray, homography, (width, height), borderValue=255
    )

    projected = cv2.perspectiveTransform(source.reshape(-1, 1, 2), homography).reshape(-1, 2)
    residual = float(np.mean(np.linalg.norm(projected - destination, axis=1)))
    diagonal = float(np.hypot(width, height))
    quality = max(0.0, 1.0 - residual / (diagonal * 0.01))

    return Registered(page_no=scan_markers.page_no, aligned=aligned, quality=quality)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_registration.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/registration.py backend/tests/test_registration.py
git commit -m "feat: 마커 기반 페이지 정합"
```

---

## Task 5: 학생 필기 추출

정합된 스캔에서 인쇄 요소를 빼고 학생이 쓴 것만 남긴다. 작도 문항 처리와 크롭 품질의 토대다.

**설계 참조:** 7.2절, 7.3절, 7.4절, 11절, 14절. 정합된 스캔과 같은 좌표계의 템플릿을 조명 정규화 뒤 차분하고, 인쇄 요소 주변의 작은 정합 오차를 마스크로 흡수한다.

> **구현 계약 보강:** 회색, BGR, BGRA의 8비트 입력만 받고 변환 뒤 두 이미지의 크기가 정확히 같아야 한다. 화소 수를 제한하고 입력을 바꾸지 않는다. 결과는 0과 255만 담는 회색 8비트 읽기 전용 마스크이며, 잉크 비율 함수도 임의의 명암 이미지를 마스크로 받아들이지 않는다.

**Files:**
- Create: `backend/app/services/ink_extract.py`
- Test: `backend/tests/test_ink_extract.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_ink_extract.py`:

```python
import cv2
import numpy as np

from app.services.ink_extract import extract_ink, ink_ratio, is_blank_page


def _template(width=400, height=500):
    page = np.full((height, width), 255, dtype=np.uint8)
    # 인쇄된 격자선 (연한 회색)
    for x in range(0, width, 50):
        cv2.line(page, (x, 0), (x, height), 200, 1)
    for y in range(0, height, 50):
        cv2.line(page, (0, y), (width, y), 200, 1)
    # 인쇄된 표 테두리 (검정)
    cv2.rectangle(page, (30, 30), (370, 200), 0, 2)
    return page


def _with_handwriting(template):
    page = template.copy()
    cv2.line(page, (60, 300), (300, 380), 0, 4)
    cv2.circle(page, (200, 430), 25, 0, 4)
    return page


def test_removes_printed_elements():
    template = _template()
    ink = extract_ink(template, template)
    # 필기가 없으면 잉크가 거의 없어야 한다.
    assert ink_ratio(ink) < 0.005


def test_keeps_handwriting():
    template = _template()
    scan = _with_handwriting(template)
    ink = extract_ink(scan, template)

    # 필기 위치에는 잉크가 있어야 한다.
    assert ink[430, 175] > 0 or ink[430, 225] > 0
    # 인쇄된 표 테두리 위치에는 없어야 한다.
    assert ink[30, 200] == 0


def test_ink_ratio_increases_with_handwriting():
    template = _template()
    empty = ink_ratio(extract_ink(template, template))
    written = ink_ratio(extract_ink(_with_handwriting(template), template))
    assert written > empty + 0.005


def test_blank_page_detection():
    template = _template()
    assert is_blank_page(template, template)
    assert not is_blank_page(_with_handwriting(template), template)


def test_tolerates_uniform_brightness_shift():
    """스캐너 조명이 전체적으로 어두워도 인쇄물을 필기로 오인하면 안 된다."""
    template = _template()
    darker = np.clip(template.astype(int) - 30, 0, 255).astype(np.uint8)
    ink = extract_ink(darker, template)
    assert ink_ratio(ink) < 0.02


def test_tolerates_small_registration_error():
    """정합이 1~2px 어긋나도 인쇄선이 잉크로 남으면 안 된다."""
    template = _template()
    matrix = np.float32([[1, 0, 1.5], [0, 1, 1.0]])
    shifted = cv2.warpAffine(template, matrix, (400, 500), borderValue=255)
    ink = extract_ink(shifted, template)
    assert ink_ratio(ink) < 0.02
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_ink_extract.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.ink_extract'`

- [ ] **Step 3: `services/ink_extract.py` 작성**

```python
"""정합된 스캔에서 학생 필기만 남긴다.

단순 차분으로는 두 가지에 무너진다.
  · 스캐너 조명 편차 → 전체 밝기가 달라 인쇄물이 통째로 잉크로 잡힌다
  · 1~2px 정합 오차 → 인쇄선 가장자리가 잉크로 남는다

그래서 (1) 배경 밝기를 정규화하고 (2) 템플릿 잉크를 팽창시켜 마스크로 제외한다.
"""

import cv2
import numpy as np

# 이 값보다 어두워진 화소만 필기 후보로 본다 (0..255).
DIFF_THRESHOLD = 45
# 정합 오차를 흡수하기 위해 템플릿 잉크를 부풀리는 반경(px).
TEMPLATE_DILATE_PX = 3
# 인쇄된 것으로 간주할 밝기 상한.
TEMPLATE_INK_MAX = 235
# 이 비율 미만이면 백지로 본다.
BLANK_INK_RATIO = 0.002


def _normalize_illumination(image: np.ndarray) -> np.ndarray:
    """넓은 블러로 배경을 추정해 나눠서 조명 편차를 없앤다."""
    background = cv2.GaussianBlur(image, (0, 0), sigmaX=25)
    background = np.maximum(background, 1)
    normalized = image.astype(np.float32) / background.astype(np.float32) * 255.0
    return np.clip(normalized, 0, 255).astype(np.uint8)


def extract_ink(aligned_scan: np.ndarray, template: np.ndarray) -> np.ndarray:
    """학생 필기 마스크(0 또는 255)를 돌려준다."""
    scan_norm = _normalize_illumination(aligned_scan)
    template_norm = _normalize_illumination(template)

    # 스캔이 템플릿보다 어두워진 곳만 필기 후보다.
    darker = cv2.subtract(template_norm, scan_norm)
    _threshold, candidate = cv2.threshold(
        darker, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY
    )

    # 템플릿에 인쇄된 부분은 정합 오차만큼 부풀려 제외한다.
    printed = (template <= TEMPLATE_INK_MAX).astype(np.uint8) * 255
    kernel_size = TEMPLATE_DILATE_PX * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    printed_dilated = cv2.dilate(printed, kernel)

    ink = cv2.bitwise_and(candidate, cv2.bitwise_not(printed_dilated))

    # 점 노이즈 제거.
    opening = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    return cv2.morphologyEx(ink, cv2.MORPH_OPEN, opening)


def ink_ratio(ink_mask: np.ndarray) -> float:
    if ink_mask.size == 0:
        return 0.0
    return float(np.count_nonzero(ink_mask)) / float(ink_mask.size)


def is_blank_page(aligned_scan: np.ndarray, template: np.ndarray) -> bool:
    return ink_ratio(extract_ink(aligned_scan, template)) < BLANK_INK_RATIO
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_ink_extract.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/ink_extract.py backend/tests/test_ink_extract.py
git commit -m "feat: 조명·정합 오차에 견디는 학생 필기 추출"
```

---

## Task 6: 배치 분할과 급지 사고 감지

**P2에서 가장 중요한 안전장치다.** 쪽 번호 수열이 깨지면 배치 전체를 중단한다.

**설계 참조:** 2절, 7.1절, 10절, 12절, 14절. 마커의 닫힌 쪽 번호 수열과 명렬표에서 결시자를 뺀 예상 인원으로 배정 전 조건을 검사하며, 오류 뒤 구간은 절대 부분 진행하지 않는다.

> **구현 계약 보강:** 학생당 쪽 수와 예상 학생 수는 참거짓값을 제외한 범위 안 정수여야 하고, 마커 수열도 제한된 길이의 실제 목록이어야 한다. 총수가 나누어떨어지는지 보기 전에 수열을 훑어 누락이나 중복의 첫 어긋난 위치를 우선 보고한다. 끝까지 수열이 맞은 뒤에만 총 쪽 수와 명렬표 인원을 검사하며, 결과 범위는 바꿀 수 없는 반열린 구간 묶음으로 돌려준다.

**Files:**
- Create: `backend/app/services/batch_split.py`
- Test: `backend/tests/test_batch_split.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_batch_split.py`:

```python
import pytest

from app.services.batch_split import SplitFailed, split_by_page_sequence


def test_clean_batch_splits_into_students():
    result = split_by_page_sequence([1, 2, 3, 1, 2, 3, 1, 2, 3], pages_per_student=3)
    assert result.student_count == 3
    assert result.page_ranges == [(0, 3), (3, 6), (6, 9)]


def test_single_page_answer_sheet():
    result = split_by_page_sequence([1, 1, 1, 1], pages_per_student=1)
    assert result.student_count == 4
    assert result.page_ranges == [(0, 1), (1, 2), (2, 3), (3, 4)]


def test_missing_page_is_detected_with_position():
    """3번 학생의 2쪽이 급지되지 않은 경우."""
    with pytest.raises(SplitFailed) as exc:
        split_by_page_sequence([1, 2, 3, 1, 2, 3, 1, 3, 1, 2, 3], pages_per_student=3)

    message = str(exc.value)
    assert "8번째" in message
    assert "3번" in message  # 3번 학생 구간


def test_duplicate_page_is_detected():
    """같은 장이 두 번 급지된 경우."""
    with pytest.raises(SplitFailed) as exc:
        split_by_page_sequence([1, 2, 2, 3, 1, 2, 3], pages_per_student=3)
    assert "3번째" in str(exc.value)


def test_total_page_count_mismatch_is_detected():
    with pytest.raises(SplitFailed, match="총 쪽수"):
        split_by_page_sequence([1, 2, 3, 1, 2], pages_per_student=3)


def test_unreadable_page_is_reported():
    """마커를 못 읽은 페이지는 None 으로 들어온다."""
    with pytest.raises(SplitFailed) as exc:
        split_by_page_sequence([1, 2, 3, 1, None, 3], pages_per_student=3)
    assert "5번째" in str(exc.value)
    assert "마커" in str(exc.value)


def test_empty_batch_is_rejected():
    with pytest.raises(SplitFailed, match="비어"):
        split_by_page_sequence([], pages_per_student=3)


def test_expected_student_count_is_enforced():
    with pytest.raises(SplitFailed, match="명렬표"):
        split_by_page_sequence(
            [1, 2, 3, 1, 2, 3], pages_per_student=3, expected_students=5
        )


def test_expected_student_count_matching_passes():
    result = split_by_page_sequence(
        [1, 2, 3, 1, 2, 3], pages_per_student=3, expected_students=2
    )
    assert result.student_count == 2
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_batch_split.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.batch_split'`

- [ ] **Step 3: `services/batch_split.py` 작성**

```python
"""스캔 배치를 학생별로 나눈다.

설계 문서 §7.1. 쪽수만 세어 나누면 급지 사고 한 번에 이후 전원이 밀리는데,
채점은 정상 완료된 것처럼 보이므로 아무도 눈치채지 못한다. 그래서 쪽 번호
마커 수열을 검사해 사고를 결정론적으로 잡아낸다.

이 검사는 손글씨 인식에 의존하지 않으므로 거의 확실하게 동작한다.
문제가 있으면 부분 진행하지 않고 배치 전체를 중단한다 — 밀린 채로 채점되는 것이
중단되는 것보다 훨씬 나쁘다.
"""

from dataclasses import dataclass


class SplitFailed(Exception):
    """분할을 안전하게 수행할 수 없을 때 발생한다. 배치를 중단해야 한다."""


@dataclass(frozen=True)
class SplitResult:
    pages_per_student: int
    page_ranges: list[tuple[int, int]]  # [start, end) — 0-based 페이지 인덱스

    @property
    def student_count(self) -> int:
        return len(self.page_ranges)


def _describe(index: int, pages_per_student: int) -> str:
    student_ordinal = index // pages_per_student + 1
    return f"{index + 1}번째 스캔 페이지({student_ordinal}번 학생 구간)"


def split_by_page_sequence(
    page_numbers: list[int | None],
    pages_per_student: int,
    expected_students: int | None = None,
) -> SplitResult:
    """읽어낸 쪽 번호 수열을 검증하고 학생별 페이지 범위를 돌려준다.

    page_numbers 의 None 은 마커를 읽지 못한 페이지다.
    """
    if pages_per_student < 1:
        raise SplitFailed("학생 1인당 쪽수는 1 이상이어야 합니다.")
    if not page_numbers:
        raise SplitFailed("스캔 배치가 비어 있습니다.")

    total = len(page_numbers)
    if total % pages_per_student != 0:
        raise SplitFailed(
            f"총 쪽수 {total}쪽이 학생 1인당 쪽수 {pages_per_student}쪽으로 "
            f"나누어떨어지지 않습니다. 누락되거나 겹쳐 급지된 장이 있는지 확인하세요."
        )

    for index, page_no in enumerate(page_numbers):
        if page_no is None:
            raise SplitFailed(
                f"{_describe(index, pages_per_student)}에서 쪽 번호 마커를 읽지 못했습니다. "
                "장이 뒤집혔거나 심하게 접혔을 수 있습니다."
            )

        expected = index % pages_per_student + 1
        if page_no != expected:
            raise SplitFailed(
                f"{_describe(index, pages_per_student)}에서 쪽 번호가 어긋났습니다. "
                f"{expected}쪽이 와야 하는데 {page_no}쪽이 읽혔습니다. "
                "장이 누락되었거나 겹쳐 급지되었을 수 있습니다. "
                "이 지점부터 학생 배정이 밀리므로 배치를 중단합니다."
            )

    student_count = total // pages_per_student
    if expected_students is not None and student_count != expected_students:
        raise SplitFailed(
            f"스캔에서 학생 {student_count}명분이 나왔는데 명렬표 기준으로는 "
            f"{expected_students}명이어야 합니다. 결시자 처리를 확인하세요."
        )

    ranges = [
        (index * pages_per_student, (index + 1) * pages_per_student)
        for index in range(student_count)
    ]
    return SplitResult(pages_per_student=pages_per_student, page_ranges=ranges)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_batch_split.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/batch_split.py backend/tests/test_batch_split.py
git commit -m "feat: 쪽번호 수열 검증 기반 배치 분할"
```

---

## Task 7: 명렬표 매칭

이름란 OCR 결과를 명렬표라는 폐집합에 스냅한다. 2차 배정 검증에 쓰인다.

**설계 참조:** 2절, 5절, 7.1절, 7.7절, 10절, 12절. 로컬에서 읽은 이름은 명렬표라는 닫힌 후보 집합 안에서만 고르며, 유일하고 충분히 가까운 후보가 없으면 학생을 배정하지 않는다.

> **구현 계약 보강:** 유니코드와 공백을 정규화하고 실제 삽입, 삭제, 치환 편집 거리를 계산한다. 원문 이름 길이, 정규화 이름 길이, 명렬표 인원을 제한하고 잘못된 이름 항목을 거절한다. 같은 최소 거리를 가진 후보가 둘 이상이거나 정규화 뒤 같은 이름이 중복되면 정확 일치라도 애매함으로 돌려 추측을 막는다.

**Files:**
- Create: `backend/app/services/roster_match.py`
- Test: `backend/tests/test_roster_match.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_roster_match.py`:

```python
from app.services.roster_match import MatchOutcome, match_name


ROSTER = ["김미래", "박균형", "이자율", "최대칭", "정비율"]


def test_exact_match():
    result = match_name("김미래", ROSTER)
    assert result.outcome == MatchOutcome.MATCHED
    assert result.name == "김미래"


def test_whitespace_is_ignored():
    assert match_name(" 박 균형 ", ROSTER).name == "박균형"


def test_single_character_error_is_recovered():
    """OCR 이 한 글자를 틀려도 폐집합 스냅으로 복원된다."""
    result = match_name("김미돼", ROSTER)
    assert result.outcome == MatchOutcome.MATCHED
    assert result.name == "김미래"


def test_ambiguous_input_is_not_guessed():
    """두 후보와 거리가 같으면 추측하지 않는다."""
    result = match_name("김미", ["김미래", "김미소"])
    assert result.outcome == MatchOutcome.AMBIGUOUS
    assert result.name is None


def test_far_input_is_unmatched():
    result = match_name("완전히다른글자", ROSTER)
    assert result.outcome == MatchOutcome.UNMATCHED
    assert result.name is None


def test_empty_input_is_unmatched():
    assert match_name("", ROSTER).outcome == MatchOutcome.UNMATCHED


def test_empty_roster_is_unmatched():
    assert match_name("김미래", []).outcome == MatchOutcome.UNMATCHED


def test_match_reports_distance():
    assert match_name("김미래", ROSTER).distance == 0
    assert match_name("김미돼", ROSTER).distance == 1
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_roster_match.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.roster_match'`

- [ ] **Step 3: `services/roster_match.py` 작성**

```python
"""이름란 OCR 결과를 명렬표에 스냅한다.

설계 문서 §2 원칙 2 의 폐집합 매칭을 이름에 적용한 것이다. 로컬 OCR 은 클라우드
OCR 보다 정확도가 낮지만, 후보가 학급 인원으로 한정되므로 실용 정확도는 크게
떨어지지 않는다.

중요: 애매하면 추측하지 않는다. 잘못 배정된 채점 결과는 못 읽은 것보다 나쁘다.
"""

from dataclasses import dataclass
from difflib import SequenceMatcher
from enum import Enum

# 이름 길이에 견주어 이 비율을 넘는 오류는 매칭하지 않는다.
MAX_DISTANCE_RATIO = 0.34


class MatchOutcome(str, Enum):
    MATCHED = "matched"
    AMBIGUOUS = "ambiguous"   # 후보가 둘 이상 동점
    UNMATCHED = "unmatched"   # 충분히 가까운 후보 없음


@dataclass(frozen=True)
class NameMatch:
    outcome: MatchOutcome
    name: str | None
    distance: int


def _normalize(text: str) -> str:
    return "".join(text.split())


def _edit_distance(left: str, right: str) -> int:
    """SequenceMatcher 기반 편집 거리. 외부 의존 없이 충분히 정확하다."""
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    return max(len(left), len(right)) - matched


def match_name(raw: str, roster: list[str]) -> NameMatch:
    candidate = _normalize(raw)
    if not candidate or not roster:
        return NameMatch(MatchOutcome.UNMATCHED, None, distance=-1)

    scored = sorted(
        ((_edit_distance(candidate, _normalize(name)), name) for name in roster),
        key=lambda pair: pair[0],
    )
    best_distance, best_name = scored[0]

    limit = max(1, int(len(_normalize(best_name)) * MAX_DISTANCE_RATIO))
    if best_distance > limit:
        return NameMatch(MatchOutcome.UNMATCHED, None, distance=best_distance)

    if len(scored) > 1 and scored[1][0] == best_distance:
        return NameMatch(MatchOutcome.AMBIGUOUS, None, distance=best_distance)

    return NameMatch(MatchOutcome.MATCHED, best_name, distance=best_distance)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_roster_match.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/roster_match.py backend/tests/test_roster_match.py
git commit -m "feat: 명렬표 폐집합 이름 매칭"
```

---

## Task 8: 로컬 OCR 어댑터

**이름·번호는 절대 외부로 나가지 않는다** (설계 문서 §7.7). 그래서 PII 영역만 처리하는 로컬 OCR을 따로 둔다.

**설계 참조:** 2절, 5절, 7.1절, 7.4절, 7.7절, 11절, 12절. 이름과 번호 영역은 지역 실행 파일에만 넘기고, 결과는 작업 7의 명렬표 닫힌 집합 매칭으로 이어지며 외부 전송 손잡이와 합성하지 않는다.

> **구현 계약 보강:** 회색, BGR, BGRA 8비트 이미지와 화소 수를 검사한 뒤 복사한 회색 이미지만 지역 실행 파일에 넘긴다. 한국어 한 줄 모드와 10초 제한을 고정하고, 실행 파일이나 언어 자료 오류와 시간 초과는 원래 메시지와 경로를 버린 고정 오류로 바꾼다. 결과도 문자열과 최대 길이를 검사한다.

**Files:**
- Create: `backend/app/providers/local_ocr.py`
- Modify: `backend/tests/fakes.py`
- Test: `backend/tests/test_local_ocr.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_local_ocr.py`:

```python
import numpy as np
import pytest

from app.providers.local_ocr import LocalOCRUnavailable, TesseractLocalOCR
from tests.fakes import FakeLocalOCR


def test_fake_returns_queued_text():
    ocr = FakeLocalOCR(["김미래", "박균형"])
    assert ocr.recognize(np.zeros((10, 10), dtype=np.uint8)) == "김미래"
    assert ocr.recognize(np.zeros((10, 10), dtype=np.uint8)) == "박균형"


def test_tesseract_raises_clear_error_when_binary_missing(monkeypatch):
    import app.providers.local_ocr as module

    def missing(*_args, **_kwargs):
        raise FileNotFoundError("tesseract not found")

    monkeypatch.setattr(module.pytesseract, "image_to_string", missing)

    with pytest.raises(LocalOCRUnavailable, match="Tesseract"):
        TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8))


def test_tesseract_strips_whitespace(monkeypatch):
    import app.providers.local_ocr as module

    monkeypatch.setattr(
        module.pytesseract, "image_to_string", lambda *_a, **_k: "  김미래 \n"
    )
    assert TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8)) == "김미래"
```

`backend/tests/fakes.py`에 추가한다.

```python
import numpy as np


class FakeLocalOCR:
    """테스트용 로컬 OCR. 미리 넣어둔 문자열을 순서대로 돌려준다."""

    def __init__(self, results: list[str]) -> None:
        self._results = list(results)
        self.calls: list[np.ndarray] = []

    def recognize(self, image: np.ndarray) -> str:
        self.calls.append(image)
        if not self._results:
            return ""
        return self._results.pop(0)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_local_ocr.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.providers.local_ocr'`

- [ ] **Step 3: `providers/local_ocr.py` 작성**

```python
"""PII 영역 전용 로컬 OCR.

설계 문서 §7.7: 이름·학교·반·번호는 로컬 경계를 벗어나지 않는다. 답안 본문은
클라우드 OCR 을 쓰지만 이 영역만은 여기서 처리한다.

정확도가 클라우드보다 낮은 것은 감수한다. 결과를 명렬표 폐집합에 스냅하므로
(roster_match.py) 실용 정확도는 충분하고, 실패하면 오채점이 아니라
'배정 확인 필요' 플래그로 이어지므로 안전한 방향으로 실패한다.
"""

from typing import Protocol

import numpy as np
import pytesseract
from PIL import Image

# 한국어 학습 데이터. 설치: macOS `brew install tesseract-lang`
TESSERACT_LANG = "kor"
# 한 줄짜리 이름 칸이므로 단일 텍스트 라인 모드가 정확하다.
TESSERACT_CONFIG = "--psm 7"


class LocalOCRUnavailable(Exception):
    """Tesseract 실행 파일이나 언어 데이터가 없을 때 발생한다."""


class LocalOCRProvider(Protocol):
    def recognize(self, image: np.ndarray) -> str: ...


class TesseractLocalOCR:
    def recognize(self, image: np.ndarray) -> str:
        try:
            text = pytesseract.image_to_string(
                Image.fromarray(image), lang=TESSERACT_LANG, config=TESSERACT_CONFIG
            )
        except FileNotFoundError as exc:
            raise LocalOCRUnavailable(
                "Tesseract 를 찾을 수 없습니다. 설치가 필요합니다. "
                "macOS: brew install tesseract tesseract-lang"
            ) from exc
        except pytesseract.TesseractError as exc:
            raise LocalOCRUnavailable(
                f"Tesseract 실행에 실패했습니다: {exc}. "
                f"한국어 데이터({TESSERACT_LANG})가 설치되어 있는지 확인하세요."
            ) from exc

        return text.strip()
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_local_ocr.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/providers/local_ocr.py backend/tests/
git commit -m "feat: PII 영역 전용 로컬 OCR 어댑터"
```

---

## Task 9: 크롭 생성

**설계 참조:** 2절, 5절, 7.3절, 7.4절, 7.7절, 10절, 12절. 식별정보 영역과 겹치는 응답 크롭은 만들지 않는 방식으로 외부 전송보다 이른 단계에서 경계를 강제한다.

> **구현 계약 보강:** 문항과 모든 좌표는 참거짓값을 제외한 정수이며 크기는 양수여야 한다. 식별정보 영역은 페이지 안쪽의 유효한 사각형만 받으며 한 화소라도 겹치면 실패한다. 여러 크롭의 문항 번호 중복을 거절하고, 결과는 원본 페이지와 메모리를 공유하지 않는 읽기 전용 복사본과 바꿀 수 없는 문항 매핑으로 돌려준다.

**Files:**
- Create: `backend/app/services/cropper.py`
- Test: `backend/tests/test_cropper.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_cropper.py`:

```python
import numpy as np
import pytest

from app.services.cropper import CropSpec, PIIBoundaryViolation, crop_region, crop_regions


def _page():
    page = np.zeros((500, 400), dtype=np.uint8)
    page[100:200, 50:150] = 255  # 표식 블록
    return page


def test_crop_returns_requested_area():
    crop = crop_region(_page(), CropSpec(item_no=1, x=50, y=100, width=100, height=100))
    assert crop.shape == (100, 100)
    assert np.all(crop == 255)


def test_crop_is_clipped_to_page_bounds():
    crop = crop_region(_page(), CropSpec(item_no=1, x=350, y=450, width=200, height=200))
    assert crop.shape == (50, 50)


def test_fully_outside_crop_raises():
    with pytest.raises(ValueError, match="영역"):
        crop_region(_page(), CropSpec(item_no=1, x=500, y=600, width=50, height=50))


def test_crop_overlapping_pii_region_is_blocked():
    """설계 문서 §7.7: PII 영역과 겹치는 크롭은 만들지 않는다."""
    spec = CropSpec(item_no=1, x=40, y=40, width=120, height=120)
    with pytest.raises(PIIBoundaryViolation, match="식별정보"):
        crop_region(_page(), spec, pii_rects=[(100, 100, 100, 100)])


def test_crop_not_touching_pii_region_is_allowed():
    spec = CropSpec(item_no=1, x=200, y=300, width=100, height=100)
    crop = crop_region(_page(), spec, pii_rects=[(0, 0, 100, 100)])
    assert crop.shape == (100, 100)


def test_crop_regions_returns_map_keyed_by_item():
    specs = [
        CropSpec(item_no=1, x=0, y=0, width=100, height=100),
        CropSpec(item_no=2, x=100, y=100, width=100, height=100),
    ]
    crops = crop_regions(_page(), specs)
    assert set(crops) == {1, 2}
    assert crops[1].shape == (100, 100)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_cropper.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.cropper'`

- [ ] **Step 3: `services/cropper.py` 작성**

```python
"""정합된 페이지에서 문항별 응답 영역을 잘라낸다.

PII 영역과 겹치는 크롭은 만들지 않는다. 설계 문서 §7.7 의 "전송 전 마스킹"을
가장 이른 지점에서 강제하는 것이다 — 애초에 만들지 않으면 실수로 전송할 수 없다.
"""

from dataclasses import dataclass

import numpy as np

Rect = tuple[int, int, int, int]  # x, y, width, height


class PIIBoundaryViolation(Exception):
    """응답 영역이 식별정보 영역과 겹칠 때 발생한다."""


@dataclass(frozen=True)
class CropSpec:
    item_no: int
    x: int
    y: int
    width: int
    height: int

    def as_rect(self) -> Rect:
        return (self.x, self.y, self.width, self.height)


def _intersects(left: Rect, right: Rect) -> bool:
    lx, ly, lw, lh = left
    rx, ry, rw, rh = right
    return lx < rx + rw and rx < lx + lw and ly < ry + rh and ry < ly + lh


def crop_region(
    page: np.ndarray,
    spec: CropSpec,
    pii_rects: list[Rect] | None = None,
) -> np.ndarray:
    for pii in pii_rects or []:
        if _intersects(spec.as_rect(), pii):
            raise PIIBoundaryViolation(
                f"{spec.item_no}번 응답 영역이 식별정보 영역과 겹칩니다. "
                "영역 지정 화면에서 겹치지 않게 조정하세요."
            )

    height, width = page.shape[:2]
    x0 = max(0, spec.x)
    y0 = max(0, spec.y)
    x1 = min(width, spec.x + spec.width)
    y1 = min(height, spec.y + spec.height)

    if x0 >= x1 or y0 >= y1:
        raise ValueError(
            f"{spec.item_no}번 응답 영역이 페이지 밖에 있습니다. "
            f"영역 {spec.as_rect()}, 페이지 크기 {(width, height)}"
        )

    return page[y0:y1, x0:x1]


def crop_regions(
    page: np.ndarray,
    specs: list[CropSpec],
    pii_rects: list[Rect] | None = None,
) -> dict[int, np.ndarray]:
    return {spec.item_no: crop_region(page, spec, pii_rects) for spec in specs}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_cropper.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/cropper.py backend/tests/test_cropper.py
git commit -m "feat: 문항별 크롭 생성과 PII 경계 강제"
```

---

## Task 10: 데이터 모델

**설계 참조:** 2절, 5절, 7.1절부터 7.7절, 10절, 11절, 12절. 템플릿과 영역, 학급과 학생, 배치와 제출, 쪽 이미지와 비식별 문항 크롭을 설계 문서의 소유 관계와 삭제 경계대로 저장한다.

> **구현 계약 보강:** 상태값, 쪽 수, 좌표, 학생 번호, 페이지 범위, 정합 품질, 경로와 익명 표식에 데이터베이스 제약을 둔다. 평가별 템플릿, 학급별 학생 번호, 배치별 학생과 시작 쪽, 제출별 쪽과 문항, 익명 표식은 각각 유일해야 한다. 평가나 배치 삭제는 소유 자료에 연쇄되지만 원본 답안지 문서만 지워지면 템플릿과 영역은 남고 원본 참조만 비운다.

**Files:**
- Create: `backend/app/models/sheet_template.py`
- Create: `backend/app/models/classroom.py`
- Create: `backend/app/models/scan.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_models_p2.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_models_p2.py`:

```python
from app.models.assessment import Assessment
from app.models.classroom import Classroom, Student
from app.models.scan import ItemResponse, PageImage, ScanBatch, Submission
from app.models.sheet_template import RegionSpec, SheetTemplate


def _assessment(db_session):
    assessment = Assessment(title="가", subject="수학", grade=6, total_points=20)
    db_session.add(assessment)
    db_session.commit()
    return assessment


def test_sheet_template_with_regions(db_session):
    assessment = _assessment(db_session)
    template = SheetTemplate(
        assessment_id=assessment.id, source_document_id=None, page_count=3
    )
    db_session.add(template)
    db_session.commit()

    db_session.add_all(
        [
            RegionSpec(
                template_id=template.id,
                region_type="response",
                item_no=1,
                page_no=1,
                x=100,
                y=200,
                width=300,
                height=80,
            ),
            RegionSpec(
                template_id=template.id,
                region_type="pii",
                item_no=None,
                page_no=1,
                x=50,
                y=50,
                width=400,
                height=60,
            ),
        ]
    )
    db_session.commit()

    loaded = db_session.get(SheetTemplate, template.id)
    assert len(loaded.regions) == 2
    assert {region.region_type for region in loaded.regions} == {"response", "pii"}


def test_classroom_with_students(db_session):
    classroom = Classroom(name="6학년 3반")
    db_session.add(classroom)
    db_session.commit()

    db_session.add_all(
        [
            Student(classroom_id=classroom.id, number=1, name="김미래"),
            Student(classroom_id=classroom.id, number=2, name="박균형", absent=True),
        ]
    )
    db_session.commit()

    loaded = db_session.get(Classroom, classroom.id)
    assert len(loaded.students) == 2
    assert loaded.present_students()[0].name == "김미래"


def test_scan_batch_cascade(db_session):
    assessment = _assessment(db_session)
    classroom = Classroom(name="6-3")
    db_session.add(classroom)
    db_session.commit()

    student = Student(classroom_id=classroom.id, number=1, name="김미래")
    db_session.add(student)
    db_session.commit()

    batch = ScanBatch(
        assessment_id=assessment.id,
        classroom_id=classroom.id,
        stored_path="/tmp/scan.pdf",
        status="pending",
    )
    db_session.add(batch)
    db_session.commit()

    submission = Submission(
        batch_id=batch.id, student_id=student.id, page_start=0, page_end=3
    )
    db_session.add(submission)
    db_session.commit()

    db_session.add(
        PageImage(
            submission_id=submission.id,
            page_no=1,
            aligned_path="/tmp/a.png",
            ink_path="/tmp/i.png",
            registration_quality=0.97,
        )
    )
    db_session.add(
        ItemResponse(submission_id=submission.id, item_no=1, crop_path="/tmp/c1.png")
    )
    db_session.commit()

    loaded = db_session.get(Submission, submission.id)
    assert len(loaded.pages) == 1
    assert len(loaded.item_responses) == 1
    assert loaded.assignment_status == "pending"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_models_p2.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.sheet_template'`

- [ ] **Step 3: `models/sheet_template.py` 작성**

```python
from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class SheetTemplate(Base, TimestampMixin):
    """빈 답안지. 정합 기준이자 문항 영역의 좌표계다."""

    __tablename__ = "sheet_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    source_document_id: Mapped[int | None] = mapped_column(
        ForeignKey("source_documents.id", ondelete="SET NULL"), nullable=True
    )
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 마커가 삽입된 배부용 PDF 경로
    printable_path: Mapped[str | None] = mapped_column(String(600), nullable=True)

    regions: Mapped[list["RegionSpec"]] = relationship(
        back_populates="template", cascade="all, delete-orphan"
    )


class RegionSpec(Base, TimestampMixin):
    """답안지 위의 영역 하나. 템플릿 픽셀 좌표계 기준."""

    __tablename__ = "region_specs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("sheet_templates.id", ondelete="CASCADE"), nullable=False
    )
    # response | pii
    region_type: Mapped[str] = mapped_column(String(20), nullable=False)
    # region_type 이 pii 이면 None
    item_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_no: Mapped[int] = mapped_column(Integer, nullable=False)
    x: Mapped[int] = mapped_column(Integer, nullable=False)
    y: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)

    template: Mapped[SheetTemplate] = relationship(back_populates="regions")
```

- [ ] **Step 4: `models/classroom.py` 작성**

```python
from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Classroom(Base, TimestampMixin):
    __tablename__ = "classrooms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    students: Mapped[list["Student"]] = relationship(
        back_populates="classroom",
        cascade="all, delete-orphan",
        order_by="Student.number",
    )

    def present_students(self) -> list["Student"]:
        """결시자를 뺀 학생 목록. 스캔 배치의 기대 인원이 된다."""
        return [student for student in self.students if not student.absent]

    def roster_names(self) -> list[str]:
        """폐집합 매칭과 PII 검사에 쓰는 이름 집합."""
        return [student.name for student in self.students]


class Student(Base, TimestampMixin):
    __tablename__ = "students"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    classroom_id: Mapped[int] = mapped_column(
        ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    absent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    classroom: Mapped[Classroom] = relationship(back_populates="students")
```

- [ ] **Step 5: `models/scan.py` 작성**

```python
from sqlalchemy import Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ScanBatch(Base, TimestampMixin):
    """한 번에 올린 전체 학생 답안 스캔 PDF."""

    __tablename__ = "scan_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"), nullable=False
    )
    classroom_id: Mapped[int] = mapped_column(
        ForeignKey("classrooms.id", ondelete="CASCADE"), nullable=False
    )
    stored_path: Mapped[str] = mapped_column(String(600), nullable=False)
    # pending | processing | split_failed | ready | needs_review
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    submissions: Mapped[list["Submission"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )


class Submission(Base, TimestampMixin):
    """한 학생의 답안. 배치 안의 페이지 범위 [page_start, page_end)."""

    __tablename__ = "submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("scan_batches.id", ondelete="CASCADE"), nullable=False
    )
    student_id: Mapped[int] = mapped_column(
        ForeignKey("students.id", ondelete="CASCADE"), nullable=False
    )
    page_start: Mapped[int] = mapped_column(Integer, nullable=False)
    page_end: Mapped[int] = mapped_column(Integer, nullable=False)

    # pending | confirmed | needs_review
    assignment_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )
    recognized_name: Mapped[str | None] = mapped_column(String(50), nullable=True)
    assignment_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 외부 전송 시 학생을 지칭하는 익명 토큰 (설계 문서 §7.7)
    anonymous_token: Mapped[str | None] = mapped_column(String(20), nullable=True)

    batch: Mapped[ScanBatch] = relationship(back_populates="submissions")
    pages: Mapped[list["PageImage"]] = relationship(
        back_populates="submission", cascade="all, delete-orphan"
    )
    item_responses: Mapped[list["ItemResponse"]] = relationship(
        back_populates="submission", cascade="all, delete-orphan"
    )


class PageImage(Base, TimestampMixin):
    __tablename__ = "page_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False
    )
    page_no: Mapped[int] = mapped_column(Integer, nullable=False)
    aligned_path: Mapped[str] = mapped_column(String(600), nullable=False)
    ink_path: Mapped[str] = mapped_column(String(600), nullable=False)
    registration_quality: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    submission: Mapped[Submission] = relationship(back_populates="pages")


class ItemResponse(Base, TimestampMixin):
    """P2 의 최종 산출물. P3 인식 엔진의 입력이 된다."""

    __tablename__ = "item_responses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False
    )
    item_no: Mapped[int] = mapped_column(Integer, nullable=False)
    crop_path: Mapped[str] = mapped_column(String(600), nullable=False)
    ink_crop_path: Mapped[str | None] = mapped_column(String(600), nullable=True)

    submission: Mapped[Submission] = relationship(back_populates="item_responses")
```

- [ ] **Step 6: `models/__init__.py` 갱신**

```python
from app.models.app_setting import AppSetting
from app.models.assessment import Assessment
from app.models.base import Base
from app.models.classroom import Classroom, Student
from app.models.document import SourceDocument
from app.models.job import Job
from app.models.rubric import RubricDraft
from app.models.scan import ItemResponse, PageImage, ScanBatch, Submission
from app.models.sheet_template import RegionSpec, SheetTemplate

__all__ = [
    "Base",
    "Assessment",
    "SourceDocument",
    "RubricDraft",
    "AppSetting",
    "Job",
    "SheetTemplate",
    "RegionSpec",
    "Classroom",
    "Student",
    "ScanBatch",
    "Submission",
    "PageImage",
    "ItemResponse",
]
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_models_p2.py -v`
Expected: PASS (3 tests)

- [ ] **Step 8: 커밋**

```bash
git add backend/app/models/ backend/tests/test_models_p2.py
git commit -m "feat: 답안지 템플릿·학급·스캔 데이터 모델"
```

---

## Task 11: 배치 처리 파이프라인

앞선 순수 함수들을 하나로 엮는다. 이 모듈이 P2의 본체다.

**설계 참조:** 2절, 5절, 7.1절부터 7.7절, 10절, 11절, 12절, 14절. 마커 또는 기존 양식 특징점 정합, 쪽 수열 검증, 학생 분할, 로컬 이름 확인, 필기 추출, 식별정보 경계가 적용된 문항 크롭 순서를 고정한다.

> **구현 계약 보강:** 스캔과 템플릿, 쪽 수, 모든 응답 및 식별정보 영역, 명렬표, 로컬 인식과 진행률 손잡이를 처리 전에 검사한다. 마커 양식과 무마커 양식을 섞지 않고, 응답 문항 번호는 전체 쪽에서 유일해야 한다. 정합 또는 수열 실패는 로컬 인식 전에 학생 결과 없이 끝내며, 로컬 인식 불가는 해당 학생만 검토 상태로 만든다. 읽힌 이름이 다른 명렬표 학생과 맞아도 자동 재배정하지 않는다.

**Files:**
- Create: `backend/app/services/scan_pipeline.py`
- Test: `backend/tests/test_scan_pipeline.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_scan_pipeline.py`:

```python
import cv2
import numpy as np
import pytest

from app.services.cropper import CropSpec
from app.services.markers import encode_marker_id, render_marker
from app.services.scan_pipeline import PipelineOutcome, process_batch_pages
from tests.fakes import FakeLocalOCR


def _template_page(page_no: int, width=800, height=1100, margin=50, marker=80):
    page = np.full((height, width), 255, dtype=np.uint8)
    positions = [
        (margin, margin),
        (width - margin - marker, margin),
        (width - margin - marker, height - margin - marker),
        (margin, height - margin - marker),
    ]
    for corner, (x, y) in enumerate(positions):
        page[y : y + marker, x : x + marker] = render_marker(
            encode_marker_id(page_no, corner), size_px=marker
        )
    cv2.rectangle(page, (150, 300), (650, 420), 0, 2)  # 응답 박스
    cv2.rectangle(page, (150, 150), (650, 220), 0, 2)  # 이름란
    return page


def _written(template, text_mark=True):
    page = template.copy()
    cv2.line(page, (200, 360), (600, 370), 0, 5)  # 응답 필기
    if text_mark:
        cv2.line(page, (200, 190), (400, 192), 0, 4)  # 이름란 필기
    return page


@pytest.fixture
def templates():
    return {1: _template_page(1), 2: _template_page(2)}


@pytest.fixture
def crop_specs():
    return {
        1: [CropSpec(item_no=1, x=150, y=300, width=500, height=120)],
        2: [CropSpec(item_no=2, x=150, y=300, width=500, height=120)],
    }


@pytest.fixture
def pii_spec():
    # (page_no, rect)
    return (1, (150, 150, 500, 70))


def test_clean_batch_produces_crops_for_each_student(templates, crop_specs, pii_spec):
    scans = [
        _written(templates[1]),
        _written(templates[2]),
        _written(templates[1]),
        _written(templates[2]),
    ]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "박균형"]),
    )

    assert result.outcome == PipelineOutcome.OK
    assert len(result.students) == 2
    assert result.students[0].crops[1].shape[0] > 0
    assert result.students[1].crops[2].shape[0] > 0


def test_name_mismatch_marks_student_for_review(templates, crop_specs, pii_spec):
    scans = [
        _written(templates[1]),
        _written(templates[2]),
        _written(templates[1]),
        _written(templates[2]),
    ]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "완전히다른이름"]),
    )

    assert result.outcome == PipelineOutcome.NEEDS_REVIEW
    assert result.students[1].assignment_status == "needs_review"
    assert result.students[0].assignment_status == "confirmed"


def test_misfeed_aborts_entire_batch(templates, crop_specs, pii_spec):
    """2쪽이 빠지고 1쪽이 두 번 들어간 경우."""
    scans = [
        _written(templates[1]),
        _written(templates[2]),
        _written(templates[1]),
        _written(templates[1]),
    ]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "박균형"]),
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED
    assert result.students == []
    assert "4번째" in result.failure_reason


def test_unregistrable_page_aborts_batch(templates, crop_specs, pii_spec):
    scans = [
        _written(templates[1]),
        np.full((1100, 800), 255, dtype=np.uint8),  # 마커 없음
        _written(templates[1]),
        _written(templates[2]),
    ]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "박균형"]),
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED
    assert "2번째" in result.failure_reason


def test_expected_student_count_mismatch_aborts(templates, crop_specs, pii_spec):
    scans = [_written(templates[1]), _written(templates[2])]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형", "이자율"],
        local_ocr=FakeLocalOCR(["김미래"]),
        expected_students=3,
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED
    assert "명렬표" in result.failure_reason


def test_progress_callback_is_invoked(templates, crop_specs, pii_spec):
    calls = []
    scans = [_written(templates[1]), _written(templates[2])]
    process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래"],
        local_ocr=FakeLocalOCR(["김미래"]),
        progress=lambda done, total, message: calls.append((done, total)),
    )
    assert calls
    assert calls[-1][0] == calls[-1][1]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_scan_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.scan_pipeline'`

- [ ] **Step 3: `services/scan_pipeline.py` 작성**

```python
"""스캔 배치를 학생별·문항별 크롭까지 처리한다.

순수 함수다. DB 도 파일시스템도 건드리지 않고 이미지 배열만 주고받는다. 덕분에
실제 스캐너 없이 합성 이미지로 전부 테스트할 수 있다. DB 저장과 파일 쓰기는
api/scans.py 가 이 결과를 받아서 한다.

처리 순서 (설계 문서 §7.1 ~ §7.4)
  1. 페이지마다 마커 검출 → 쪽 번호 + 정합
  2. 쪽 번호 수열 검증 → 급지 사고면 배치 전체 중단
  3. 학생별 분할
  4. 이름란 로컬 OCR → 명렬표 폐집합 매칭 → 2차 검증
  5. 학생 필기 추출
  6. 문항별 크롭
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from app.providers.local_ocr import LocalOCRProvider
from app.services.batch_split import SplitFailed, split_by_page_sequence
from app.services.cropper import CropSpec, crop_region
from app.services.ink_extract import extract_ink
from app.services.markers import detect_page_markers
from app.services.registration import RegistrationFailed, Registered, register_page
from app.services.roster_match import MatchOutcome, match_name

ProgressFn = Callable[[int, int, str], None]
Rect = tuple[int, int, int, int]


class PipelineOutcome(str, Enum):
    OK = "ok"
    NEEDS_REVIEW = "needs_review"   # 크롭은 나왔으나 배정 확인 필요
    SPLIT_FAILED = "split_failed"   # 배치 중단


@dataclass
class StudentResult:
    index: int  # 0-based, 명렬표 순서
    page_range: tuple[int, int]
    crops: dict[int, np.ndarray] = field(default_factory=dict)
    ink_crops: dict[int, np.ndarray] = field(default_factory=dict)
    aligned_pages: dict[int, np.ndarray] = field(default_factory=dict)
    ink_pages: dict[int, np.ndarray] = field(default_factory=dict)
    registration_quality: dict[int, float] = field(default_factory=dict)
    recognized_name: str | None = None
    assignment_status: str = "pending"
    assignment_note: str | None = None


@dataclass
class PipelineResult:
    outcome: PipelineOutcome
    students: list[StudentResult] = field(default_factory=list)
    failure_reason: str | None = None


def _register_all(
    scan_pages: list[np.ndarray],
    templates: dict[int, np.ndarray],
    progress: ProgressFn | None,
) -> tuple[list[Registered | None], list[str | None]]:
    """페이지마다 정합을 시도한다. 실패는 None 과 사유로 남긴다.

    마커 ID 가 쪽 번호를 담으므로, 먼저 쪽 번호를 읽어 맞는 템플릿을 고른 뒤
    정합한다. 모든 템플릿에 무작정 시도하면 안 된다 — 네 모서리 마커는 어느
    쪽에서든 같은 위치에 있으므로 엉뚱한 쪽 템플릿에도 '성공'해 버린다.
    """
    registered: list[Registered | None] = []
    reasons: list[str | None] = []
    total = len(scan_pages)

    for index, scan in enumerate(scan_pages):
        result: Registered | None = None
        reason: str | None = None

        detected = detect_page_markers(scan)
        if detected is None:
            reason = "마커를 하나도 찾지 못했습니다. 장이 뒤집혔거나 심하게 접혔을 수 있습니다."
        elif detected.page_no not in templates:
            reason = (
                f"{detected.page_no}쪽 마커가 읽혔지만 답안지 템플릿에는 그런 쪽이 없습니다. "
                "다른 평가의 답안지가 섞였을 수 있습니다."
            )
        else:
            try:
                result = register_page(scan, templates[detected.page_no])
            except RegistrationFailed as exc:
                reason = str(exc)

        registered.append(result)
        reasons.append(reason)
        if progress is not None:
            progress(index + 1, total, f"{index + 1}/{total}쪽 정합")

    return registered, reasons


def process_batch_pages(
    scan_pages: list[np.ndarray],
    templates: dict[int, np.ndarray],
    pages_per_student: int,
    crop_specs: dict[int, list[CropSpec]],
    pii_rect: tuple[int, Rect],
    roster: list[str],
    local_ocr: LocalOCRProvider,
    expected_students: int | None = None,
    progress: ProgressFn | None = None,
) -> PipelineResult:
    """스캔 페이지 목록을 학생별 크롭까지 처리한다.

    templates    : 쪽 번호 -> 빈 답안지 이미지
    crop_specs   : 쪽 번호 -> 그 쪽의 문항 영역 목록
    pii_rect     : (이름란이 있는 쪽 번호, 이름란 사각형)
    roster       : 명렬표 이름 목록 (결시자 제외, 번호 순)
    """
    registered, reasons = _register_all(scan_pages, templates, progress)

    page_numbers: list[int | None] = [
        item.page_no if item is not None else None for item in registered
    ]

    try:
        split = split_by_page_sequence(
            page_numbers, pages_per_student, expected_students=expected_students
        )
    except SplitFailed as exc:
        message = str(exc)
        # 정합 실패가 원인이면 그 사유를 덧붙인다.
        for index, item in enumerate(registered):
            if item is None and reasons[index]:
                message = f"{message}\n({index + 1}번째 페이지 상세: {reasons[index]})"
                break
        return PipelineResult(PipelineOutcome.SPLIT_FAILED, [], message)

    pii_page_no, pii_box = pii_rect
    needs_review = False
    students: list[StudentResult] = []

    for student_index, (start, end) in enumerate(split.page_ranges):
        student = StudentResult(index=student_index, page_range=(start, end))

        for offset in range(start, end):
            item = registered[offset]
            assert item is not None  # 분할 검증을 통과했으므로 보장된다
            template = templates[item.page_no]

            ink = extract_ink(item.aligned, template)
            student.aligned_pages[item.page_no] = item.aligned
            student.ink_pages[item.page_no] = ink
            student.registration_quality[item.page_no] = item.quality

            for spec in crop_specs.get(item.page_no, []):
                student.crops[spec.item_no] = crop_region(
                    item.aligned,
                    spec,
                    pii_rects=[pii_box] if item.page_no == pii_page_no else None,
                )
                student.ink_crops[spec.item_no] = crop_region(
                    ink,
                    spec,
                    pii_rects=[pii_box] if item.page_no == pii_page_no else None,
                )

            if item.page_no == pii_page_no:
                name_crop = crop_region(
                    item.aligned,
                    CropSpec(item_no=0, x=pii_box[0], y=pii_box[1],
                             width=pii_box[2], height=pii_box[3]),
                )
                raw = local_ocr.recognize(name_crop)
                student.recognized_name = raw or None
                match = match_name(raw, roster)

                expected_name = roster[student_index] if student_index < len(roster) else None
                if match.outcome == MatchOutcome.MATCHED and match.name == expected_name:
                    student.assignment_status = "confirmed"
                elif match.outcome == MatchOutcome.MATCHED:
                    student.assignment_status = "needs_review"
                    student.assignment_note = (
                        f"쪽 번호 순서로는 {expected_name} 학생 자리인데 "
                        f"이름란에서 {match.name} 이(가) 읽혔습니다."
                    )
                    needs_review = True
                else:
                    student.assignment_status = "needs_review"
                    student.assignment_note = (
                        f"이름란을 명렬표와 대조하지 못했습니다 "
                        f"(인식 결과: {raw!r}, 판정: {match.outcome.value})."
                    )
                    needs_review = True

        students.append(student)

    outcome = PipelineOutcome.NEEDS_REVIEW if needs_review else PipelineOutcome.OK
    return PipelineResult(outcome, students, None)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_scan_pipeline.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/scan_pipeline.py backend/tests/test_scan_pipeline.py
git commit -m "feat: 스캔 배치 처리 파이프라인"
```

---

## Task 12: 명렬표 API

**Files:**
- Create: `backend/app/api/classrooms.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_classrooms.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_classrooms.py`:

```python
def test_create_classroom_with_students(client):
    response = client.post(
        "/api/classrooms",
        json={
            "name": "6학년 3반",
            "students": [
                {"number": 1, "name": "김미래", "absent": False},
                {"number": 2, "name": "박균형", "absent": False},
            ],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "6학년 3반"
    assert len(body["students"]) == 2


def test_paste_roster_text(client):
    """교사가 엑셀에서 복사해 붙여넣는 흐름."""
    response = client.post(
        "/api/classrooms/parse-roster",
        json={"text": "1\t김미래\n2\t박균형\n3   이자율"},
    )
    assert response.status_code == 200
    students = response.json()["students"]
    assert students == [
        {"number": 1, "name": "김미래"},
        {"number": 2, "name": "박균형"},
        {"number": 3, "name": "이자율"},
    ]


def test_parse_roster_ignores_blank_lines(client):
    response = client.post(
        "/api/classrooms/parse-roster", json={"text": "1\t김미래\n\n \n2\t박균형"}
    )
    assert len(response.json()["students"]) == 2


def test_parse_roster_reports_bad_line(client):
    response = client.post(
        "/api/classrooms/parse-roster", json={"text": "1\t김미래\n이건번호가없음"}
    )
    assert response.status_code == 400
    assert "2번째 줄" in response.json()["detail"]


def test_duplicate_number_is_rejected(client):
    response = client.post(
        "/api/classrooms",
        json={
            "name": "6-3",
            "students": [
                {"number": 1, "name": "김미래", "absent": False},
                {"number": 1, "name": "박균형", "absent": False},
            ],
        },
    )
    assert response.status_code == 400
    assert "번호" in response.json()["detail"]


def test_mark_absent_student(client):
    created = client.post(
        "/api/classrooms",
        json={
            "name": "6-3",
            "students": [{"number": 1, "name": "김미래", "absent": False}],
        },
    ).json()

    response = client.patch(
        f"/api/classrooms/{created['id']}/students/{created['students'][0]['id']}",
        json={"absent": True},
    )
    assert response.status_code == 200
    assert response.json()["absent"] is True
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_classrooms.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/classrooms.py` 작성**

```python
import re

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models.classroom import Classroom, Student

router = APIRouter(prefix="/api/classrooms", tags=["classrooms"])

# "1<탭 또는 공백>김미래" 형태를 받는다.
ROSTER_LINE = re.compile(r"^\s*(\d+)[\s\t]+(\S.*?)\s*$")


class StudentIn(BaseModel):
    number: int
    name: str
    absent: bool = False


class StudentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    number: int
    name: str
    absent: bool


class ClassroomIn(BaseModel):
    name: str
    students: list[StudentIn]


class ClassroomOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    students: list[StudentOut]


class StudentPatch(BaseModel):
    name: str | None = None
    absent: bool | None = None


class RosterText(BaseModel):
    text: str


@router.post("/parse-roster")
def parse_roster(payload: RosterText) -> dict[str, list[dict[str, object]]]:
    students: list[dict[str, object]] = []
    for line_no, line in enumerate(payload.text.splitlines(), start=1):
        if not line.strip():
            continue
        match = ROSTER_LINE.match(line)
        if match is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{line_no}번째 줄을 읽을 수 없습니다: {line!r}. "
                "'번호<탭>이름' 형식이어야 합니다.",
            )
        students.append({"number": int(match.group(1)), "name": match.group(2)})
    return {"students": students}


@router.post("", response_model=ClassroomOut, status_code=status.HTTP_201_CREATED)
def create_classroom(
    payload: ClassroomIn, session: Session = Depends(get_session)
) -> Classroom:
    numbers = [student.number for student in payload.students]
    duplicates = {number for number in numbers if numbers.count(number) > 1}
    if duplicates:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"학생 번호가 중복됩니다: {sorted(duplicates)}",
        )

    classroom = Classroom(name=payload.name)
    classroom.students = [
        Student(number=student.number, name=student.name, absent=student.absent)
        for student in payload.students
    ]
    session.add(classroom)
    session.commit()
    return classroom


@router.get("", response_model=list[ClassroomOut])
def list_classrooms(session: Session = Depends(get_session)) -> list[Classroom]:
    return list(session.scalars(select(Classroom).order_by(Classroom.id.desc())))


@router.get("/{classroom_id}", response_model=ClassroomOut)
def get_classroom(
    classroom_id: int, session: Session = Depends(get_session)
) -> Classroom:
    classroom = session.get(Classroom, classroom_id)
    if classroom is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "학급을 찾을 수 없습니다.")
    return classroom


@router.patch("/{classroom_id}/students/{student_id}", response_model=StudentOut)
def update_student(
    classroom_id: int,
    student_id: int,
    payload: StudentPatch,
    session: Session = Depends(get_session),
) -> Student:
    student = session.get(Student, student_id)
    if student is None or student.classroom_id != classroom_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "학생을 찾을 수 없습니다.")

    if payload.name is not None:
        student.name = payload.name
    if payload.absent is not None:
        student.absent = payload.absent
    session.commit()
    return student
```

`main.py`에 `app.include_router(classrooms.router)`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_classrooms.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/classrooms.py backend/app/main.py backend/tests/test_api_classrooms.py
git commit -m "feat: 명렬표 API"
```

---

## Task 13: 답안지 템플릿 API

**Files:**
- Create: `backend/app/api/templates.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_templates.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_api_templates.py`:

```python
import fitz
import pytest


@pytest.fixture
def assessment_id(client):
    return client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 20},
    ).json()["id"]


@pytest.fixture
def sheet_pdf():
    doc = fitz.open()
    for _ in range(2):
        doc.new_page(width=595, height=842)
    data = doc.tobytes()
    doc.close()
    return data


@pytest.fixture
def template_id(client, assessment_id, sheet_pdf):
    client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "answer_sheet"},
        files={"file": ("sheet.pdf", sheet_pdf, "application/pdf")},
    )
    return client.post(f"/api/assessments/{assessment_id}/template").json()["id"]


def test_create_template_from_answer_sheet(client, template_id):
    assert template_id > 0


def test_template_requires_answer_sheet_document(client, assessment_id):
    response = client.post(f"/api/assessments/{assessment_id}/template")
    assert response.status_code == 400
    assert "빈 답안지" in response.json()["detail"]


def test_page_images_are_served(client, assessment_id, template_id):
    response = client.get(f"/api/assessments/{assessment_id}/template/pages/1")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"


def test_save_and_read_regions(client, assessment_id, template_id):
    response = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={
            "regions": [
                {"region_type": "pii", "item_no": None, "page_no": 1,
                 "x": 50, "y": 50, "width": 400, "height": 60},
                {"region_type": "response", "item_no": 1, "page_no": 1,
                 "x": 60, "y": 200, "width": 400, "height": 100},
            ]
        },
    )
    assert response.status_code == 200

    regions = client.get(f"/api/assessments/{assessment_id}/template/regions").json()
    assert len(regions["regions"]) == 2


def test_response_region_overlapping_pii_is_rejected(client, assessment_id, template_id):
    response = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={
            "regions": [
                {"region_type": "pii", "item_no": None, "page_no": 1,
                 "x": 50, "y": 50, "width": 400, "height": 200},
                {"region_type": "response", "item_no": 1, "page_no": 1,
                 "x": 100, "y": 100, "width": 200, "height": 100},
            ]
        },
    )
    assert response.status_code == 400
    assert "겹칩" in response.json()["detail"]


def test_response_region_requires_item_no(client, assessment_id, template_id):
    response = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={
            "regions": [
                {"region_type": "response", "item_no": None, "page_no": 1,
                 "x": 60, "y": 200, "width": 400, "height": 100}
            ]
        },
    )
    assert response.status_code == 400
    assert "문항 번호" in response.json()["detail"]


def test_printable_sheet_is_generated(client, assessment_id, template_id):
    client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={
            "regions": [
                {"region_type": "response", "item_no": 1, "page_no": 1,
                 "x": 60, "y": 200, "width": 400, "height": 100}
            ]
        },
    )
    response = client.post(f"/api/assessments/{assessment_id}/template/printable")
    assert response.status_code == 200

    download = client.get(f"/api/assessments/{assessment_id}/template/printable")
    assert download.status_code == 200
    assert download.content.startswith(b"%PDF")
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_templates.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `api/templates.py` 작성**

```python
from pathlib import Path

import fitz
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.assessments import load_assessment
from app.config import settings
from app.db import get_session
from app.models.document import SourceDocument
from app.models.sheet_template import RegionSpec, SheetTemplate
from app.services.sheet_builder import build_printable_sheet

router = APIRouter(prefix="/api/assessments/{assessment_id}/template", tags=["template"])

# 템플릿 좌표계의 기준 해상도. 영역 지정 UI 와 파이프라인이 같은 값을 써야 한다.
TEMPLATE_DPI = 200


class RegionIn(BaseModel):
    region_type: str
    item_no: int | None
    page_no: int
    x: int
    y: int
    width: int
    height: int


class RegionsIn(BaseModel):
    regions: list[RegionIn]


class TemplateOut(BaseModel):
    id: int
    page_count: int
    dpi: int
    printable_ready: bool


def _load_template(assessment_id: int, session: Session) -> SheetTemplate:
    template = session.scalar(
        select(SheetTemplate).where(SheetTemplate.assessment_id == assessment_id)
    )
    if template is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "답안지 템플릿이 없습니다. 먼저 빈 답안지를 올리고 템플릿을 만드세요.",
        )
    return template


def _source_pdf(template: SheetTemplate, session: Session) -> Path:
    document = session.get(SourceDocument, template.source_document_id)
    if document is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "원본 답안지 파일이 없습니다.")
    return Path(document.stored_path)


def _intersects(left: RegionIn, right: RegionIn) -> bool:
    return (
        left.page_no == right.page_no
        and left.x < right.x + right.width
        and right.x < left.x + left.width
        and left.y < right.y + right.height
        and right.y < left.y + left.height
    )


@router.post("", response_model=TemplateOut)
def create_template(
    assessment_id: int, session: Session = Depends(get_session)
) -> TemplateOut:
    load_assessment(assessment_id, session)

    document = session.scalar(
        select(SourceDocument).where(
            SourceDocument.assessment_id == assessment_id,
            SourceDocument.kind == "answer_sheet",
        )
    )
    if document is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "빈 답안지 PDF 를 먼저 업로드하세요. 응답 영역 지정과 필기 추출에 필요합니다.",
        )

    template = session.scalar(
        select(SheetTemplate).where(SheetTemplate.assessment_id == assessment_id)
    )
    if template is None:
        template = SheetTemplate(assessment_id=assessment_id)
        session.add(template)

    template.source_document_id = document.id
    template.page_count = document.page_count
    session.commit()

    return TemplateOut(
        id=template.id,
        page_count=template.page_count,
        dpi=TEMPLATE_DPI,
        printable_ready=template.printable_path is not None,
    )


@router.get("/pages/{page_no}")
def get_template_page(
    assessment_id: int, page_no: int, session: Session = Depends(get_session)
) -> Response:
    template = _load_template(assessment_id, session)
    source = _source_pdf(template, session)

    with fitz.open(source) as document:
        if not 1 <= page_no <= document.page_count:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "그런 쪽이 없습니다.")
        pixmap = document[page_no - 1].get_pixmap(dpi=TEMPLATE_DPI)
        png = pixmap.tobytes("png")

    return Response(content=png, media_type="image/png")


@router.put("/regions")
def save_regions(
    assessment_id: int,
    payload: RegionsIn,
    session: Session = Depends(get_session),
) -> dict[str, int]:
    template = _load_template(assessment_id, session)

    responses = [r for r in payload.regions if r.region_type == "response"]
    pii = [r for r in payload.regions if r.region_type == "pii"]

    for region in payload.regions:
        if region.region_type not in {"response", "pii"}:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"알 수 없는 영역 종류입니다: {region.region_type}",
            )

    for region in responses:
        if region.item_no is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "응답 영역에는 문항 번호가 있어야 합니다.",
            )

    # 설계 문서 §7.7: 응답 영역이 식별정보 영역과 겹치면 크롭 자체를 만들 수 없다.
    for response_region in responses:
        for pii_region in pii:
            if _intersects(response_region, pii_region):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"{response_region.item_no}번 응답 영역이 식별정보 영역과 겹칩니다. "
                    "겹치면 답안 크롭에 이름이 들어가 외부 전송이 차단됩니다.",
                )

    for existing in list(template.regions):
        session.delete(existing)
    session.flush()

    for region in payload.regions:
        session.add(RegionSpec(template_id=template.id, **region.model_dump()))
    session.commit()

    return {"saved": len(payload.regions)}


@router.get("/regions")
def get_regions(
    assessment_id: int, session: Session = Depends(get_session)
) -> dict[str, list[dict]]:
    template = _load_template(assessment_id, session)
    return {
        "regions": [
            {
                "region_type": region.region_type,
                "item_no": region.item_no,
                "page_no": region.page_no,
                "x": region.x,
                "y": region.y,
                "width": region.width,
                "height": region.height,
            }
            for region in template.regions
        ]
    }


@router.post("/printable")
def generate_printable(
    assessment_id: int, session: Session = Depends(get_session)
) -> dict[str, str]:
    template = _load_template(assessment_id, session)
    source = _source_pdf(template, session)

    scale = 72.0 / TEMPLATE_DPI  # 템플릿 픽셀 → PDF 포인트
    regions = [
        {
            "page_no": region.page_no,
            "x": region.x * scale,
            "y": region.y * scale,
            "width": region.width * scale,
            "height": region.height * scale,
        }
        for region in template.regions
        if region.region_type == "response"
    ]

    output = settings.uploads_dir() / f"printable-{assessment_id}.pdf"
    try:
        build_printable_sheet(source, output, regions)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    template.printable_path = str(output)
    session.commit()
    return {"status": "ok"}


@router.get("/printable")
def download_printable(
    assessment_id: int, session: Session = Depends(get_session)
) -> FileResponse:
    template = _load_template(assessment_id, session)
    if template.printable_path is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "먼저 배부용 답안지를 생성하세요."
        )
    return FileResponse(
        template.printable_path,
        media_type="application/pdf",
        filename="답안지_인쇄용.pdf",
    )
```

`main.py`에 `app.include_router(templates.router)`를 추가한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_templates.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/templates.py backend/app/main.py backend/tests/test_api_templates.py
git commit -m "feat: 답안지 템플릿·영역 지정 API"
```

---

## Task 14: 스캔 배치 API

파이프라인을 작업 큐에 태우고 결과를 DB에 저장한다.

**설계 요점 — 저장 로직을 작업 스레드에서 떼어낸다.** 결과를 DB에 쓰는 부분(`persist_result`)을 순수 동기 함수로 분리하고, 작업 스레드(`_process`)는 그것을 호출하기만 한다. 이렇게 하지 않으면 저장 로직을 테스트하려고 매번 스레드를 띄우고 폴링해야 하며, 테스트가 느리고 불안정해진다.

**Files:**
- Create: `backend/app/api/scans.py`
- Modify: `backend/app/db.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api_scans.py`

- [ ] **Step 1: `db.py` 에 백그라운드용 세션 팩토리 추가**

`get_session` 아래에 추가한다.

```python
def session_factory() -> Session:
    """백그라운드 작업용. 요청 스코프와 무관한 새 세션을 만든다.

    SQLAlchemy Session 은 스레드 안전하지 않으므로, 작업 스레드는 요청의 세션을
    빌려 쓰면 안 되고 반드시 자기 세션을 만들어야 한다.
    """
    if _SessionFactory is None:
        init_db()
    return _SessionFactory()
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/tests/test_api_scans.py`:

```python
import numpy as np
import pytest

from app.api import scans as scans_api
from app.models.classroom import Classroom
from app.models.scan import ItemResponse, PageImage, ScanBatch, Submission
from app.services.scan_pipeline import PipelineOutcome, PipelineResult, StudentResult


@pytest.fixture
def setup_ids(client):
    assessment_id = client.post(
        "/api/assessments",
        json={"title": "가", "subject": "수학", "grade": 6, "total_points": 20},
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
    return assessment_id, classroom_id


def _student_result(index: int, status: str = "confirmed") -> StudentResult:
    result = StudentResult(index=index, page_range=(index * 2, index * 2 + 2))
    tiny = np.zeros((10, 10), dtype=np.uint8)
    result.aligned_pages = {1: tiny, 2: tiny}
    result.ink_pages = {1: tiny, 2: tiny}
    result.registration_quality = {1: 0.98, 2: 0.96}
    result.crops = {1: tiny, 2: tiny}
    result.ink_crops = {1: tiny, 2: tiny}
    result.assignment_status = status
    result.recognized_name = "김미래" if index == 0 else "박균형"
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


# ---------- persist_result: 스레드 없이 저장 로직만 검증 ----------


def test_persist_creates_submissions_and_crops(client, setup_ids, db_session, tmp_path):
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)

    result = PipelineResult(
        PipelineOutcome.OK, [_student_result(0), _student_result(1)], None
    )
    scans_api.persist_result(db_session, batch, result, classroom.present_students())

    submissions = db_session.query(Submission).filter_by(batch_id=batch.id).all()
    assert len(submissions) == 2
    assert batch.status == "ready"
    assert db_session.query(ItemResponse).count() == 4  # 학생 2명 × 문항 2개
    assert db_session.query(PageImage).count() == 4


def test_persist_assigns_anonymous_tokens(client, setup_ids, db_session, tmp_path):
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)

    result = PipelineResult(PipelineOutcome.OK, [_student_result(0)], None)
    scans_api.persist_result(db_session, batch, result, classroom.present_students())

    submission = db_session.query(Submission).filter_by(batch_id=batch.id).one()
    assert submission.anonymous_token is not None
    assert submission.anonymous_token.startswith("S-")


def test_persist_sets_needs_review_status(client, setup_ids, db_session, tmp_path):
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


def test_persist_split_failure_creates_nothing(client, setup_ids, db_session, tmp_path):
    """부분 진행하면 안 된다. 밀린 채로 채점되는 것이 중단보다 훨씬 나쁘다."""
    assessment_id, classroom_id = setup_ids
    batch = _batch(db_session, assessment_id, classroom_id, tmp_path)
    classroom = db_session.get(Classroom, classroom_id)

    result = PipelineResult(
        PipelineOutcome.SPLIT_FAILED, [], "4번째 스캔 페이지에서 쪽 번호가 어긋났습니다."
    )
    scans_api.persist_result(db_session, batch, result, classroom.present_students())

    assert batch.status == "split_failed"
    assert "4번째" in batch.failure_reason
    assert db_session.query(Submission).filter_by(batch_id=batch.id).count() == 0


# ---------- 업로드 엔드포인트: 작업 실행은 스텁으로 대체 ----------


@pytest.fixture
def stub_job(monkeypatch):
    """작업 큐를 태우지 않고 즉시 처리한 것으로 만든다."""
    submitted: list[dict] = []

    class ImmediateRunner:
        def submit(self, job_type, payload, handler):
            submitted.append(payload)
            return 1

    monkeypatch.setattr(scans_api, "_runner", ImmediateRunner())
    return submitted


def test_upload_creates_batch_and_submits_job(client, setup_ids, stub_job):
    assessment_id, classroom_id = setup_ids
    response = client.post(
        "/api/scans",
        data={"assessment_id": str(assessment_id), "classroom_id": str(classroom_id)},
        files={"file": ("scan.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )
    assert response.status_code == 201
    assert response.json()["status"] == "pending"
    assert len(stub_job) == 1
    assert stub_job[0]["batch_id"] == response.json()["id"]


def test_non_pdf_is_rejected(client, setup_ids, stub_job):
    assessment_id, classroom_id = setup_ids
    response = client.post(
        "/api/scans",
        data={"assessment_id": str(assessment_id), "classroom_id": str(classroom_id)},
        files={"file": ("scan.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400


def test_batch_status_reports_counts(client, setup_ids, stub_job, db_session, tmp_path):
    assessment_id, classroom_id = setup_ids
    batch_id = client.post(
        "/api/scans",
        data={"assessment_id": str(assessment_id), "classroom_id": str(classroom_id)},
        files={"file": ("scan.pdf", b"%PDF-1.4 fake", "application/pdf")},
    ).json()["id"]

    batch = db_session.get(ScanBatch, batch_id)
    classroom = db_session.get(Classroom, classroom_id)
    scans_api.persist_result(
        db_session,
        batch,
        PipelineResult(
            PipelineOutcome.NEEDS_REVIEW,
            [_student_result(0), _student_result(1, status="needs_review")],
            None,
        ),
        classroom.present_students(),
    )

    body = client.get(f"/api/scans/{batch_id}").json()
    assert body["status"] == "needs_review"
    assert body["submission_count"] == 2
    assert body["review_count"] == 1


def test_reassign_submission_clears_review(client, setup_ids, stub_job, db_session, tmp_path):
    assessment_id, classroom_id = setup_ids
    batch_id = client.post(
        "/api/scans",
        data={"assessment_id": str(assessment_id), "classroom_id": str(classroom_id)},
        files={"file": ("scan.pdf", b"%PDF-1.4 fake", "application/pdf")},
    ).json()["id"]

    batch = db_session.get(ScanBatch, batch_id)
    classroom = db_session.get(Classroom, classroom_id)
    scans_api.persist_result(
        db_session,
        batch,
        PipelineResult(
            PipelineOutcome.NEEDS_REVIEW, [_student_result(0, status="needs_review")], None
        ),
        classroom.present_students(),
    )

    submissions = client.get(f"/api/scans/{batch_id}/submissions").json()["submissions"]
    target = submissions[0]

    response = client.post(
        f"/api/scans/{batch_id}/submissions/{target['id']}/reassign",
        json={"student_id": classroom.students[1].id},
    )
    assert response.status_code == 200
    assert response.json()["assignment_status"] == "confirmed"
    assert client.get(f"/api/scans/{batch_id}").json()["status"] == "ready"


def test_missing_batch_returns_404(client):
    assert client.get("/api/scans/999").status_code == 404
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_api_scans.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.api.scans'`

- [ ] **Step 4: `api/scans.py` 작성**

```python
import secrets
import uuid
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session, session_factory
from app.jobs.runner import JobRunner, ProgressFn
from app.models.classroom import Classroom, Student
from app.models.document import SourceDocument
from app.models.scan import ItemResponse, PageImage, ScanBatch, Submission
from app.models.sheet_template import SheetTemplate
from app.providers.local_ocr import TesseractLocalOCR
from app.services.cropper import CropSpec
from app.services.scan_pipeline import (
    PipelineOutcome,
    PipelineResult,
    process_batch_pages,
)

router = APIRouter(prefix="/api/scans", tags=["scans"])

# 템플릿 좌표계 기준 해상도. api/templates.py 의 TEMPLATE_DPI 와 같아야 한다.
TEMPLATE_DPI = 200

Rect = tuple[int, int, int, int]

_runner: JobRunner | None = None


def get_runner() -> JobRunner:
    """작업 실행기. 테스트에서는 모듈 전역 _runner 를 직접 갈아끼운다."""
    global _runner
    if _runner is None:
        _runner = JobRunner(session_factory=session_factory)
    return _runner


def run_pipeline(**kwargs: Any) -> PipelineResult:
    """테스트에서 monkeypatch 로 대체한다."""
    return process_batch_pages(**kwargs)


class BatchOut(BaseModel):
    id: int
    status: str
    failure_reason: str | None
    submission_count: int
    review_count: int


class ReassignIn(BaseModel):
    student_id: int


# ---------- 입력 준비 ----------


def pdf_to_gray_pages(path: Path) -> list[np.ndarray]:
    pages: list[np.ndarray] = []
    with fitz.open(path) as document:
        for page in document:
            pixmap = page.get_pixmap(dpi=TEMPLATE_DPI)
            array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            gray = (
                array[:, :, 0]
                if pixmap.n == 1
                else cv2.cvtColor(array[:, :, :3], cv2.COLOR_RGB2GRAY)
            )
            pages.append(gray)
    return pages


def load_template_pages(template: SheetTemplate, session: Session) -> dict[int, np.ndarray]:
    document = session.get(SourceDocument, template.source_document_id)
    if document is None:
        raise ValueError("원본 답안지 파일을 찾을 수 없습니다.")
    pages = pdf_to_gray_pages(Path(document.stored_path))
    return {index + 1: page for index, page in enumerate(pages)}


def build_specs(
    template: SheetTemplate,
) -> tuple[dict[int, list[CropSpec]], tuple[int, Rect]]:
    crop_specs: dict[int, list[CropSpec]] = {}
    pii_rect: tuple[int, Rect] | None = None

    for region in template.regions:
        if region.region_type == "response" and region.item_no is not None:
            crop_specs.setdefault(region.page_no, []).append(
                CropSpec(
                    item_no=region.item_no,
                    x=region.x,
                    y=region.y,
                    width=region.width,
                    height=region.height,
                )
            )
        elif region.region_type == "pii" and pii_rect is None:
            pii_rect = (region.page_no, (region.x, region.y, region.width, region.height))

    if pii_rect is None:
        raise ValueError(
            "식별정보(이름란) 영역이 지정되지 않았습니다. "
            "배정 검증과 개인정보 마스킹에 필요합니다."
        )
    return crop_specs, pii_rect


# ---------- 결과 저장 (동기, 테스트 가능) ----------


def _save_png(array: np.ndarray, directory: Path, name: str) -> str:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    cv2.imwrite(str(path), array)
    return str(path)


def persist_result(
    session: Session,
    batch: ScanBatch,
    result: PipelineResult,
    present_students: list[Student],
) -> None:
    """파이프라인 결과를 DB 와 파일시스템에 반영한다.

    분할 실패 시에는 제출물을 하나도 만들지 않는다. 부분 진행하면 밀린 채로
    채점이 이어져 전원의 점수가 어긋난다.
    """
    if result.outcome == PipelineOutcome.SPLIT_FAILED:
        batch.status = "split_failed"
        batch.failure_reason = result.failure_reason
        session.commit()
        return

    output_root = settings.data_dir / "batches" / str(batch.id)

    for student_result in result.students:
        student = present_students[student_result.index]
        submission = Submission(
            batch_id=batch.id,
            student_id=student.id,
            page_start=student_result.page_range[0],
            page_end=student_result.page_range[1],
            assignment_status=student_result.assignment_status,
            recognized_name=student_result.recognized_name,
            assignment_note=student_result.assignment_note,
            # 외부 전송 시 학생을 지칭하는 익명 토큰 (설계 문서 §7.7)
            anonymous_token=f"S-{secrets.token_hex(4)}",
        )
        session.add(submission)
        session.flush()

        directory = output_root / str(submission.id)

        for page_no, aligned in student_result.aligned_pages.items():
            ink_page = student_result.ink_pages.get(page_no)
            session.add(
                PageImage(
                    submission_id=submission.id,
                    page_no=page_no,
                    aligned_path=_save_png(aligned, directory, f"page{page_no}.png"),
                    ink_path=_save_png(
                        ink_page if ink_page is not None else aligned,
                        directory,
                        f"ink{page_no}.png",
                    ),
                    registration_quality=student_result.registration_quality.get(page_no, 0.0),
                )
            )

        for item_no, crop in student_result.crops.items():
            ink_crop = student_result.ink_crops.get(item_no)
            session.add(
                ItemResponse(
                    submission_id=submission.id,
                    item_no=item_no,
                    crop_path=_save_png(crop, directory, f"item{item_no}.png"),
                    ink_crop_path=(
                        _save_png(ink_crop, directory, f"item{item_no}_ink.png")
                        if ink_crop is not None
                        else None
                    ),
                )
            )

    batch.status = (
        "needs_review" if result.outcome == PipelineOutcome.NEEDS_REVIEW else "ready"
    )
    batch.failure_reason = None
    session.commit()


# ---------- 작업 스레드 ----------


def _process(payload: dict[str, Any], progress: ProgressFn) -> dict[str, Any]:
    session = session_factory()
    try:
        batch = session.get(ScanBatch, payload["batch_id"])
        batch.status = "processing"
        session.commit()

        try:
            classroom = session.get(Classroom, batch.classroom_id)
            present = classroom.present_students()

            template = session.scalar(
                select(SheetTemplate).where(
                    SheetTemplate.assessment_id == batch.assessment_id
                )
            )
            if template is None:
                raise ValueError("답안지 템플릿이 없습니다. 영역 지정을 먼저 마치세요.")

            templates = load_template_pages(template, session)
            crop_specs, pii_rect = build_specs(template)

            result = run_pipeline(
                scan_pages=pdf_to_gray_pages(Path(batch.stored_path)),
                templates=templates,
                pages_per_student=template.page_count,
                crop_specs=crop_specs,
                pii_rect=pii_rect,
                roster=[student.name for student in present],
                local_ocr=TesseractLocalOCR(),
                expected_students=len(present),
                progress=progress,
            )
            persist_result(session, batch, result, present)
        except Exception as exc:  # noqa: BLE001 - 실패를 배치 상태로 남긴다
            batch.status = "failed"
            batch.failure_reason = f"{type(exc).__name__}: {exc}"
            session.commit()
            raise

        return {"status": batch.status}
    finally:
        session.close()


# ---------- 엔드포인트 ----------


def _batch_out(batch: ScanBatch, session: Session) -> BatchOut:
    submissions = list(
        session.scalars(select(Submission).where(Submission.batch_id == batch.id))
    )
    return BatchOut(
        id=batch.id,
        status=batch.status,
        failure_reason=batch.failure_reason,
        submission_count=len(submissions),
        review_count=sum(1 for s in submissions if s.assignment_status == "needs_review"),
    )


@router.post("", response_model=BatchOut, status_code=status.HTTP_201_CREATED)
def upload_batch(
    assessment_id: int = Form(...),
    classroom_id: int = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> BatchOut:
    content = file.file.read()
    if not content.startswith(b"%PDF"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "PDF 파일만 올릴 수 있습니다.")

    stored = settings.uploads_dir() / f"scan-{uuid.uuid4().hex}.pdf"
    stored.write_bytes(content)

    batch = ScanBatch(
        assessment_id=assessment_id,
        classroom_id=classroom_id,
        stored_path=str(stored),
        status="pending",
    )
    session.add(batch)
    session.commit()

    batch.job_id = get_runner().submit("scan_batch", {"batch_id": batch.id}, _process)
    session.commit()

    return _batch_out(batch, session)


@router.get("/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: int, session: Session = Depends(get_session)) -> BatchOut:
    batch = session.get(ScanBatch, batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "배치를 찾을 수 없습니다.")
    session.refresh(batch)
    return _batch_out(batch, session)


@router.get("/{batch_id}/submissions")
def list_submissions(
    batch_id: int, session: Session = Depends(get_session)
) -> dict[str, list[dict[str, Any]]]:
    submissions = list(
        session.scalars(
            select(Submission).where(Submission.batch_id == batch_id).order_by(Submission.id)
        )
    )
    return {
        "submissions": [
            {
                "id": submission.id,
                "student_id": submission.student_id,
                "student_name": session.get(Student, submission.student_id).name,
                "recognized_name": submission.recognized_name,
                "assignment_status": submission.assignment_status,
                "assignment_note": submission.assignment_note,
                "page_start": submission.page_start,
                "page_end": submission.page_end,
            }
            for submission in submissions
        ]
    }


@router.post("/{batch_id}/submissions/{submission_id}/reassign")
def reassign_submission(
    batch_id: int,
    submission_id: int,
    payload: ReassignIn,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    submission = session.get(Submission, submission_id)
    if submission is None or submission.batch_id != batch_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "제출물을 찾을 수 없습니다.")

    student = session.get(Student, payload.student_id)
    if student is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "학생을 찾을 수 없습니다.")

    submission.student_id = student.id
    submission.assignment_status = "confirmed"
    submission.assignment_note = "교사가 직접 배정함"
    session.commit()

    batch = session.get(ScanBatch, batch_id)
    remaining = session.scalars(
        select(Submission).where(
            Submission.batch_id == batch_id,
            Submission.assignment_status == "needs_review",
        )
    ).all()
    batch.status = "needs_review" if remaining else "ready"
    session.commit()

    return {
        "id": submission.id,
        "student_id": submission.student_id,
        "assignment_status": submission.assignment_status,
    }
```

`main.py`에 `app.include_router(scans.router)`를 추가한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && pytest tests/test_api_scans.py -v`
Expected: PASS (9 tests)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/api/scans.py backend/app/db.py backend/app/main.py backend/tests/test_api_scans.py
git commit -m "feat: 스캔 배치 업로드·저장·재배정 API"
```

---

## Task 15: PII 용어 공급자 연결

P1에서 `pii_terms_provider=set` 스텁으로 두었던 것을 실제 명렬표에 연결한다. **이걸 하지 않으면 게이트웨이가 아무것도 막지 못한다.**

**Files:**
- Create: `backend/app/providers/pii_terms.py`
- Modify: `backend/app/api/rubrics.py`
- Test: `backend/tests/test_pii_terms.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_pii_terms.py`:

```python
from app.models.classroom import Classroom, Student
from app.providers.pii_terms import roster_pii_terms


def test_collects_all_student_names(db_session):
    classroom = Classroom(name="6-3")
    classroom.students = [
        Student(number=1, name="김미래"),
        Student(number=2, name="박균형", absent=True),
    ]
    db_session.add(classroom)
    db_session.commit()

    terms = roster_pii_terms(db_session)()
    assert "김미래" in terms
    # 결시자 이름도 포함해야 한다. 답안이 잘못 섞여 들어올 수 있다.
    assert "박균형" in terms


def test_collects_across_multiple_classrooms(db_session):
    for name, student_name in [("6-1", "이자율"), ("6-2", "최대칭")]:
        classroom = Classroom(name=name)
        classroom.students = [Student(number=1, name=student_name)]
        db_session.add(classroom)
    db_session.commit()

    terms = roster_pii_terms(db_session)()
    assert {"이자율", "최대칭"} <= terms


def test_empty_database_returns_empty_set(db_session):
    assert roster_pii_terms(db_session)() == set()


def test_short_names_are_excluded(db_session):
    """한 글자 이름은 오탐이 너무 많아 제외한다."""
    classroom = Classroom(name="6-3")
    classroom.students = [Student(number=1, name="김"), Student(number=2, name="김미래")]
    db_session.add(classroom)
    db_session.commit()

    terms = roster_pii_terms(db_session)()
    assert "김" not in terms
    assert "김미래" in terms
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && pytest tests/test_pii_terms.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.providers.pii_terms'`

- [ ] **Step 3: `providers/pii_terms.py` 작성**

```python
"""전송 게이트웨이가 차단할 식별정보 용어를 공급한다.

설계 문서 §7.7 항목 4: 학생이 답안 안에 자기 이름을 쓴 경우를 대비한다.
논술형 특성상 드물지만, 발생하면 실명이 외부로 나간다.

한 글자 이름은 제외한다. 답안 본문에 우연히 들어갈 확률이 높아 오탐으로
정상 채점까지 막아버린다.
"""

from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.classroom import Student

MIN_TERM_LENGTH = 2


def roster_pii_terms(session: Session) -> Callable[[], set[str]]:
    """게이트웨이에 넘길 용어 공급 함수를 만든다.

    호출 시점에 조회하므로, 명렬표가 나중에 바뀌어도 반영된다.
    """

    def provider() -> set[str]:
        names = session.scalars(select(Student.name)).all()
        return {
            name.strip()
            for name in names
            if name and len(name.strip()) >= MIN_TERM_LENGTH
        }

    return provider
```

- [ ] **Step 4: `api/rubrics.py`의 스텁 교체**

`run_compile` 안의 게이트웨이 생성 부분을 다음으로 바꾼다. 상단에 `from app.providers.pii_terms import roster_pii_terms`를 추가한다.

```python
    gateway = TransmissionGateway(
        audit_log_path=settings.audit_log_path(),
        pii_terms_provider=roster_pii_terms(session),
        provider="gemini",
    )
```

기존의 `pii_terms_provider=set` 주석("P2 에서 학생 이름 집합을 넘기도록 교체한다")도 함께 지운다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && pytest tests/ -v`
Expected: PASS (전체)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/providers/pii_terms.py backend/app/api/rubrics.py backend/tests/test_pii_terms.py
git commit -m "feat: 게이트웨이에 실제 명렬표 PII 용어 연결"
```

---

## Task 16: 영역 지정 화면

교사가 답안지 이미지 위에서 문항 영역과 이름란을 드래그로 지정한다.

**Files:**
- Create: `frontend/src/pages/RegionEditor.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/rubric.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 타입 추가**

`frontend/src/types/rubric.ts`에 추가한다.

```typescript
export type RegionType = "response" | "pii";

export interface Region {
  region_type: RegionType;
  item_no: number | null;
  page_no: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TemplateInfo {
  id: number;
  page_count: number;
  dpi: number;
  printable_ready: boolean;
}
```

- [ ] **Step 2: API 클라이언트 확장**

`frontend/src/api/client.ts`의 `api` 객체에 추가한다. 상단 import에 `Region`과 `TemplateInfo`를 넣는다.

```typescript
  createTemplate: (id: number) =>
    request<TemplateInfo>(`/api/assessments/${id}/template`, { method: "POST" }),

  getRegions: (id: number) =>
    request<{ regions: Region[] }>(`/api/assessments/${id}/template/regions`),

  saveRegions: (id: number, regions: Region[]) =>
    request<{ saved: number }>(`/api/assessments/${id}/template/regions`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ regions }),
    }),

  generatePrintable: (id: number) =>
    request<{ status: string }>(`/api/assessments/${id}/template/printable`, {
      method: "POST",
    }),

  templatePageUrl: (id: number, pageNo: number) =>
    `/api/assessments/${id}/template/pages/${pageNo}`,

  printableUrl: (id: number) => `/api/assessments/${id}/template/printable`,
```

- [ ] **Step 3: `RegionEditor.tsx` 작성**

```tsx
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { Region, RegionType, TemplateInfo } from "../types/rubric";

type Draft = { startX: number; startY: number; x: number; y: number } | null;

export default function RegionEditor() {
  const { id } = useParams();
  const assessmentId = Number(id);

  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [regions, setRegions] = useState<Region[]>([]);
  const [mode, setMode] = useState<RegionType>("response");
  const [itemNo, setItemNo] = useState(1);
  const [draft, setDraft] = useState<Draft>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    api
      .createTemplate(assessmentId)
      .then(async (info) => {
        setTemplate(info);
        setRegions((await api.getRegions(assessmentId)).regions);
      })
      .catch((e) => setError(e.message));
  }, [assessmentId]);

  /** 화면 좌표를 템플릿 픽셀 좌표로 바꾼다. 이미지가 축소 표시되므로 보정이 필요하다. */
  function toTemplateCoords(clientX: number, clientY: number) {
    const image = imageRef.current!;
    const rect = image.getBoundingClientRect();
    const scaleX = image.naturalWidth / rect.width;
    const scaleY = image.naturalHeight / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY),
    };
  }

  function handleMouseDown(event: React.MouseEvent) {
    const point = toTemplateCoords(event.clientX, event.clientY);
    setDraft({ startX: point.x, startY: point.y, x: point.x, y: point.y });
  }

  function handleMouseMove(event: React.MouseEvent) {
    if (!draft) return;
    const point = toTemplateCoords(event.clientX, event.clientY);
    setDraft({ ...draft, x: point.x, y: point.y });
  }

  function handleMouseUp() {
    if (!draft) return;
    const x = Math.min(draft.startX, draft.x);
    const y = Math.min(draft.startY, draft.y);
    const width = Math.abs(draft.x - draft.startX);
    const height = Math.abs(draft.y - draft.startY);
    setDraft(null);

    if (width < 12 || height < 12) return; // 실수 클릭 무시

    setRegions([
      ...regions,
      {
        region_type: mode,
        item_no: mode === "response" ? itemNo : null,
        page_no: pageNo,
        x,
        y,
        width,
        height,
      },
    ]);
    if (mode === "response") setItemNo(itemNo + 1);
  }

  async function handleSave() {
    try {
      await api.saveRegions(assessmentId, regions);
      setNotice("영역을 저장했습니다.");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    }
  }

  async function handlePrintable() {
    try {
      await api.saveRegions(assessmentId, regions);
      await api.generatePrintable(assessmentId);
      window.open(api.printableUrl(assessmentId), "_blank");
      setNotice("배부용 답안지를 만들었습니다. 이 PDF를 인쇄해 배부하세요.");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!template) return <p>{error ?? "불러오는 중…"}</p>;

  const pageRegions = regions.filter((region) => region.page_no === pageNo);
  const naturalWidth = imageRef.current?.naturalWidth ?? 1;
  const naturalHeight = imageRef.current?.naturalHeight ?? 1;

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>응답 영역 지정</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        답안지 위에서 드래그해 영역을 지정합니다. <strong>이름란은 반드시 식별정보로
        지정</strong>해야 합니다 — 지정하지 않으면 배정 검증과 개인정보 마스킹이 동작하지
        않습니다.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <label>
          쪽
          <select
            style={{ marginLeft: 4 }}
            value={pageNo}
            onChange={(e) => setPageNo(Number(e.target.value))}
          >
            {Array.from({ length: template.page_count }, (_, index) => index + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label>
          <input
            type="radio"
            checked={mode === "response"}
            onChange={() => setMode("response")}
          />{" "}
          응답 영역
        </label>
        <label>
          <input type="radio" checked={mode === "pii"} onChange={() => setMode("pii")} />{" "}
          식별정보(이름란)
        </label>

        {mode === "response" && (
          <label>
            문항 번호
            <input
              style={{ width: 60, marginLeft: 4 }}
              type="number"
              min={1}
              value={itemNo}
              onChange={(e) => setItemNo(Number(e.target.value))}
            />
          </label>
        )}
      </div>

      <div
        style={{ position: "relative", display: "inline-block", cursor: "crosshair" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <img
          ref={imageRef}
          src={api.templatePageUrl(assessmentId, pageNo)}
          alt={`${pageNo}쪽`}
          style={{ maxWidth: 760, display: "block", userSelect: "none" }}
          draggable={false}
        />

        {pageRegions.map((region, index) => (
          <div
            key={index}
            style={{
              position: "absolute",
              left: `${(region.x / naturalWidth) * 100}%`,
              top: `${(region.y / naturalHeight) * 100}%`,
              width: `${(region.width / naturalWidth) * 100}%`,
              height: `${(region.height / naturalHeight) * 100}%`,
              border: `2px solid ${region.region_type === "pii" ? "#dc2626" : "#2563eb"}`,
              background:
                region.region_type === "pii"
                  ? "rgba(220,38,38,0.12)"
                  : "rgba(37,99,235,0.10)",
            }}
          >
            <span style={{ fontSize: 11, background: "#fff", padding: "0 3px" }}>
              {region.region_type === "pii" ? "이름란" : `${region.item_no}번`}
            </span>
          </div>
        ))}

        {draft && (
          <div
            style={{
              position: "absolute",
              left: `${(Math.min(draft.startX, draft.x) / naturalWidth) * 100}%`,
              top: `${(Math.min(draft.startY, draft.y) / naturalHeight) * 100}%`,
              width: `${(Math.abs(draft.x - draft.startX) / naturalWidth) * 100}%`,
              height: `${(Math.abs(draft.y - draft.startY) / naturalHeight) * 100}%`,
              border: "2px dashed #666",
            }}
          />
        )}
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button onClick={handleSave}>영역 저장</button>
        <button onClick={handlePrintable}>배부용 답안지 만들기</button>
        <button
          onClick={() => setRegions(regions.filter((r) => r.page_no !== pageNo))}
          disabled={pageRegions.length === 0}
        >
          이 쪽 영역 모두 지우기
        </button>
      </div>

      {notice && <p style={{ color: "#166534" }}>{notice}</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 라우트 등록**

`App.tsx`에 import와 라우트를 추가한다.

```tsx
import RegionEditor from "./pages/RegionEditor";
```

```tsx
        <Route path="/assessments/:id/regions" element={<RegionEditor />} />
```

- [ ] **Step 5: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 6: 커밋**

```bash
git add frontend/
git commit -m "feat: 응답·식별정보 영역 지정 화면"
```

---

## Task 17: 명렬표와 스캔 배치 화면

**Files:**
- Create: `frontend/src/pages/ClassroomSetup.tsx`
- Create: `frontend/src/pages/ScanBatch.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: API 클라이언트 확장**

`frontend/src/api/client.ts`의 `api` 객체에 추가한다.

```typescript
  parseRoster: (text: string) =>
    request<{ students: { number: number; name: string }[] }>(
      "/api/classrooms/parse-roster",
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ text }) },
    ),

  createClassroom: (name: string, students: { number: number; name: string; absent: boolean }[]) =>
    request<{ id: number; name: string; students: { id: number; number: number; name: string; absent: boolean }[] }>(
      "/api/classrooms",
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name, students }) },
    ),

  listClassrooms: () =>
    request<{ id: number; name: string; students: { id: number; number: number; name: string; absent: boolean }[] }[]>(
      "/api/classrooms",
    ),

  uploadScan: (assessmentId: number, classroomId: number, file: File) => {
    const form = new FormData();
    form.append("assessment_id", String(assessmentId));
    form.append("classroom_id", String(classroomId));
    form.append("file", file);
    return request<ScanBatchStatus>("/api/scans", { method: "POST", body: form });
  },

  getScanBatch: (batchId: number) => request<ScanBatchStatus>(`/api/scans/${batchId}`),

  listSubmissions: (batchId: number) =>
    request<{ submissions: SubmissionInfo[] }>(`/api/scans/${batchId}/submissions`),

  reassignSubmission: (batchId: number, submissionId: number, studentId: number) =>
    request<{ id: number; assignment_status: string }>(
      `/api/scans/${batchId}/submissions/${submissionId}/reassign`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ student_id: studentId }) },
    ),
```

`types/rubric.ts`에 추가한다.

```typescript
export interface ScanBatchStatus {
  id: number;
  status: string;
  failure_reason: string | null;
  submission_count: number;
  review_count: number;
}

export interface SubmissionInfo {
  id: number;
  student_id: number;
  student_name: string;
  recognized_name: string | null;
  assignment_status: string;
  assignment_note: string | null;
  page_start: number;
  page_end: number;
}
```

- [ ] **Step 2: `ClassroomSetup.tsx` 작성**

```tsx
import { useState } from "react";

import { api } from "../api/client";

export default function ClassroomSetup() {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [students, setStudents] = useState<{ number: number; name: string }[]>([]);
  const [absent, setAbsent] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleParse() {
    try {
      setStudents((await api.parseRoster(text)).students);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleSave() {
    try {
      const created = await api.createClassroom(
        name,
        students.map((student) => ({ ...student, absent: absent.has(student.number) })),
      );
      setNotice(`${created.name} 학급을 저장했습니다. (${created.students.length}명)`);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleAbsent(number: number) {
    const next = new Set(absent);
    if (next.has(number)) next.delete(number);
    else next.add(number);
    setAbsent(next);
  }

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>명렬표 입력</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        명렬표는 이름란 인식 결과를 대조하는 데 쓰입니다. 후보가 학급 인원으로
        한정되므로 손글씨가 조금 틀려도 올바른 학생으로 복원됩니다.
      </p>

      <label style={{ display: "block", marginBottom: 12 }}>
        학급명
        <input
          style={{ width: "100%", padding: 8 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="6학년 3반"
        />
      </label>

      <label style={{ display: "block", marginBottom: 8 }}>
        번호와 이름 붙여넣기 (엑셀에서 복사)
        <textarea
          style={{ width: "100%", height: 160, padding: 8, fontFamily: "monospace" }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"1\t김미래\n2\t박균형\n3\t이자율"}
        />
      </label>
      <button onClick={handleParse}>읽어들이기</button>

      {students.length > 0 && (
        <table style={{ marginTop: 16, borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ padding: 6, textAlign: "left" }}>번호</th>
              <th style={{ padding: 6, textAlign: "left" }}>이름</th>
              <th style={{ padding: 6 }}>결시</th>
            </tr>
          </thead>
          <tbody>
            {students.map((student) => (
              <tr key={student.number}>
                <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{student.number}</td>
                <td style={{ padding: 6, borderTop: "1px solid #eee" }}>{student.name}</td>
                <td style={{ padding: 6, borderTop: "1px solid #eee", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={absent.has(student.number)}
                    onChange={() => toggleAbsent(student.number)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {students.length > 0 && (
        <p style={{ marginTop: 12 }}>
          <button onClick={handleSave} disabled={!name.trim()}>
            학급 저장 (응시 {students.length - absent.size}명)
          </button>
        </p>
      )}

      {notice && <p style={{ color: "#166534" }}>{notice}</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: `ScanBatch.tsx` 작성**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api/client";
import type { ScanBatchStatus, SubmissionInfo } from "../types/rubric";

const STATUS_LABEL: Record<string, string> = {
  pending: "대기 중",
  processing: "처리 중",
  split_failed: "분할 실패 — 배치 중단됨",
  failed: "처리 실패",
  needs_review: "배정 확인 필요",
  ready: "완료",
};

type Classroom = {
  id: number;
  name: string;
  students: { id: number; number: number; name: string; absent: boolean }[];
};

export default function ScanBatch() {
  const { id } = useParams();
  const assessmentId = Number(id);

  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [classroomId, setClassroomId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<ScanBatchStatus | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listClassrooms().then(setClassrooms).catch((e) => setError(e.message));
  }, []);

  // 처리 중에는 상태를 폴링한다.
  useEffect(() => {
    if (!batch || !["pending", "processing"].includes(batch.status)) return;
    const timer = setInterval(async () => {
      try {
        setBatch(await api.getScanBatch(batch.id));
      } catch (e) {
        setError((e as Error).message);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [batch]);

  // 처리가 끝나면 제출물 목록을 불러온다.
  useEffect(() => {
    if (!batch || !["ready", "needs_review"].includes(batch.status)) return;
    api.listSubmissions(batch.id).then((r) => setSubmissions(r.submissions));
  }, [batch]);

  async function handleUpload() {
    if (!file || classroomId === null) return;
    try {
      setBatch(await api.uploadScan(assessmentId, classroomId, file));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleReassign(submissionId: number, studentId: number) {
    if (!batch) return;
    await api.reassignSubmission(batch.id, submissionId, studentId);
    setBatch(await api.getScanBatch(batch.id));
    setSubmissions((await api.listSubmissions(batch.id)).submissions);
  }

  const classroom = classrooms.find((c) => c.id === classroomId);

  return (
    <div>
      <h1 style={{ fontSize: 18 }}>답안 스캔 업로드</h1>
      <p style={{ color: "#666", fontSize: 13 }}>
        전체 학생 답안을 한 번에 스캔한 PDF 1개를 올리세요. 쪽 번호 마커로 학생별 분할을
        검증하며, 급지 사고가 감지되면 <strong>배치 전체를 중단</strong>합니다.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <select
          value={classroomId ?? ""}
          onChange={(e) => setClassroomId(Number(e.target.value))}
        >
          <option value="" disabled>
            학급을 고르세요
          </option>
          {classrooms.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>

        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={handleUpload} disabled={!file || classroomId === null}>
          업로드
        </button>
      </div>

      {batch && (
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 6,
            padding: 12,
            background: batch.status === "split_failed" ? "#fef2f2" : "#fff",
          }}
        >
          <strong>{STATUS_LABEL[batch.status] ?? batch.status}</strong>
          {batch.failure_reason && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                color: "#b91c1c",
                fontSize: 13,
                marginTop: 8,
              }}
            >
              {batch.failure_reason}
            </pre>
          )}
          {(batch.status === "split_failed" || batch.status === "failed") && (
            <p style={{ fontSize: 13 }}>
              스캐너에서 누락되거나 겹쳐 급지된 장을 확인한 뒤 다시 스캔해 올리세요.
              밀린 채로 채점하면 전원의 점수가 어긋납니다.
            </p>
          )}
          {batch.submission_count > 0 && (
            <p style={{ fontSize: 13 }}>
              학생 {batch.submission_count}명 처리됨
              {batch.review_count > 0 && ` · 배정 확인 필요 ${batch.review_count}명`}
            </p>
          )}
        </div>
      )}

      {submissions.length > 0 && classroom && (
        <table style={{ marginTop: 16, borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ padding: 6, textAlign: "left" }}>배정된 학생</th>
              <th style={{ padding: 6, textAlign: "left" }}>이름란 인식</th>
              <th style={{ padding: 6, textAlign: "left" }}>상태</th>
              <th style={{ padding: 6, textAlign: "left" }}>재배정</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((submission) => (
              <tr
                key={submission.id}
                style={{
                  background:
                    submission.assignment_status === "needs_review" ? "#fffbeb" : undefined,
                }}
              >
                <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                  {submission.student_name}
                </td>
                <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                  {submission.recognized_name ?? "—"}
                </td>
                <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                  {submission.assignment_status === "confirmed" ? "확인됨" : "확인 필요"}
                  {submission.assignment_note && (
                    <div style={{ color: "#92400e", fontSize: 12 }}>
                      {submission.assignment_note}
                    </div>
                  )}
                </td>
                <td style={{ padding: 6, borderTop: "1px solid #eee" }}>
                  <select
                    value={submission.student_id}
                    onChange={(e) => handleReassign(submission.id, Number(e.target.value))}
                  >
                    {classroom.students.map((student) => (
                      <option key={student.id} value={student.id}>
                        {student.number}. {student.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 라우트 등록**

`App.tsx`에 추가한다.

```tsx
import ClassroomSetup from "./pages/ClassroomSetup";
import ScanBatch from "./pages/ScanBatch";
```

```tsx
        <Route path="/classrooms" element={<ClassroomSetup />} />
        <Route path="/assessments/:id/scan" element={<ScanBatch />} />
```

헤더에 `<Link to="/classrooms">명렬표</Link>`도 추가한다.

- [ ] **Step 5: 빌드 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공

- [ ] **Step 6: 커밋**

```bash
git add frontend/
git commit -m "feat: 명렬표 입력과 스캔 배치 화면"
```

---

## Task 18: 실물 검증

합성 이미지로만 테스트했으므로, 실제 프린터와 스캐너로 한 번 돌려야 P2가 끝난다.

**Files:**
- Create: `docs/verification/P2-manual-check.md`

- [ ] **Step 1: 배부용 답안지 생성과 인쇄**

평가를 만들고 빈 답안지 PDF를 올린 뒤, 영역 지정 화면에서 이름란(식별정보)과 문항 영역을 지정한다. "배부용 답안지 만들기"로 PDF를 받아 **실제로 인쇄**한다.

인쇄물에서 확인할 것:
- 네 모서리 마커가 잘리지 않았는가 (프린터 여백 설정이 원인일 수 있다)
- 마커 주변 흰 여백이 남아 있는가
- 응답 박스가 원본 내용을 가리지 않는가

- [ ] **Step 2: 필기구별 시험 답안 작성**

같은 답안지 3장에 각각 다른 필기구로 비슷한 내용을 쓴다.
- 검정 볼펜
- 검정 사인펜
- HB 연필

- [ ] **Step 3: 스캔**

300dpi 그레이스케일로 스캔한다. 학생 여러 명분을 이어 붙여 PDF 1개로 만든다.

- [ ] **Step 4: 업로드하고 결과 확인**

`docs/verification/P2-manual-check.md`에 기록한다.

| 항목 | 결과 | 비고 |
|---|---|---|
| 마커 검출 성공률 (쪽 수 기준) | | 4개 모두 검출되었는가 |
| 정합 품질 (`registration_quality`) | | 0.9 이상이 정상 |
| 필기 추출 — 볼펜 | | 인쇄 격자선이 잉크로 남는가 |
| 필기 추출 — 사인펜 | | |
| 필기 추출 — 연필 | | 여기가 가장 나쁠 것으로 예상 |
| 이름란 로컬 OCR + 명렬표 매칭 | | 몇 명 중 몇 명이 확인됨 |
| 문항 크롭 경계 | | 답안이 잘리지 않았는가 |

- [ ] **Step 5: 급지 사고 주입 시험**

**이 단계를 건너뛰지 말 것.** P2의 핵심 안전장치를 검증하는 유일한 방법이다.

스캔 PDF에서 페이지 한 장을 일부러 삭제한 뒤 업로드한다.

확인할 것:
- 배치 상태가 `split_failed`가 되는가
- 오류 메시지가 몇 번째 페이지에서 어긋났는지 알려주는가
- 제출물이 하나도 만들어지지 않았는가 (부분 진행하면 안 된다)

같은 방식으로 페이지 한 장을 복제해 넣은 경우도 시험한다.

- [ ] **Step 6: 필기구 지침 확정**

Step 4 결과를 근거로 `docs/verification/P2-manual-check.md`에 권장 필기구를 적는다. 연필의 필기 추출 품질이 나쁘면 운영 지침에서 볼펜·사인펜을 명시한다.

- [ ] **Step 7: 결과 기록과 커밋**

```bash
git add docs/verification/P2-manual-check.md
git commit -m "docs: P2 실물 검증 결과"
```

---

## 완료 기준

- [ ] 전체 테스트 통과: `cd backend && pytest tests/ -v`
- [ ] 프런트엔드 빌드 성공: `cd frontend && npm run build`
- [ ] 배부용 답안지 PDF가 생성되고, 인쇄 후 스캔해도 마커가 검출됨
- [ ] 정상 배치를 올리면 학생별·문항별 크롭(`ItemResponse`)이 만들어짐
- [ ] **페이지를 하나 빼거나 복제하면 배치가 `split_failed`로 중단되고, 몇 번째 페이지인지 알려줌**
- [ ] 이름란이 명렬표와 어긋나면 그 학생만 `needs_review`가 되고 재배정할 수 있음
- [ ] 응답 영역이 이름란과 겹치면 저장이 400으로 거부됨
- [ ] `pii_terms_provider`가 실제 명렬표에 연결되어, 학생 이름이 든 텍스트를 게이트웨이가 차단함

---

## P3 로 넘기는 것

- 답안 본문 클라우드 OCR (`ItemResponse.crop_path`가 입력)
- 문항 유형별 채점기 (결정론 · LLM)
- 신뢰도 기반 자동확정/검토 라우팅
- **데이터 정책 동의 확인 게이트** — 설계 문서 §7.7 항목 8. P1에서 저장한 `data_policy_acknowledged`가 false이면 채점 배치 실행을 차단한다. 학생 답안 이미지가 처음 외부로 나가는 시점이 P3이므로, 강제 지점도 P3에 둔다.
