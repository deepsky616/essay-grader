import math
import os
from pathlib import Path
import stat
from threading import RLock
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from app.api.settings import (
    get_credential_store,
    read_llm_runtime,
    read_setting,
)
from app.config import settings
from app.db import get_session, session_factory
from app.models.app_setting import (
    DATA_POLICY_WORDING_TEXT,
    DATA_POLICY_WORDING_VERSION,
    KEY_DATA_POLICY_ACK,
    DataPolicyAcknowledgement,
)
from app.models.assessment import Assessment
from app.models.classroom import Student
from app.models.grading import GradingRun, ItemScore
from app.models.rubric import RubricDraft
from app.models.scan import ItemResponse, ScanBatch, Submission
from app.providers.base import LLMProvider
from app.providers.credentials import CredentialStore
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider
from app.providers.gemini_recognition import GeminiRecognitionProvider
from app.providers.pii_terms import roster_pii_terms
from app.schemas.rubric import Rubric, RubricItem
from app.services.grading_pipeline import (
    ScoredItem,
    SubmissionContext,
    grade_submission,
)
from app.services.rubric_validator import validate_rubric


router = APIRouter(prefix="/api/grading", tags=["grading"])
_CREATE_RUN_LOCK = RLock()
_RUN_FAILURE = "채점 실행 중 오류가 발생했습니다."
MAX_CROP_BYTES = 20 * 1024 * 1024


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_id: Annotated[StrictInt, Field(ge=1)]
    review_all: StrictBool = False
    confidence_threshold: Annotated[
        float,
        Field(strict=True, ge=0.0, le=1.0, allow_inf_nan=False),
    ] = 0.90


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    batch_id: int
    status: str
    failure_reason: str | None
    total_count: int
    auto_count: int
    manual_count: int


class ScoreOut(BaseModel):
    id: int
    submission_id: int
    student_name: str
    item_no: int
    proposed_score: int | None
    final_score: int | None
    confirmed: bool
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float
    route: str
    routing_reasons: list[str]
    recognized_raw: str


def grade_one_submission(**kwargs: Any) -> list[ScoredItem]:
    return grade_submission(**kwargs)


def build_llm_provider(
    api_key: str,
    model: str,
    gateway: TransmissionGateway,
) -> LLMProvider:
    return create_gemini_provider(
        api_key=api_key,
        model=model,
        gateway=gateway,
    )


def _assert_policy_acknowledged(session: Session) -> None:
    latest = session.scalar(
        select(DataPolicyAcknowledgement)
        .order_by(DataPolicyAcknowledgement.id.desc())
        .limit(1)
    )
    if (
        read_setting(session, KEY_DATA_POLICY_ACK) != "true"
        or latest is None
        or not latest.acknowledged
        or latest.wording_version != DATA_POLICY_WORDING_VERSION
        or latest.wording_text != DATA_POLICY_WORDING_TEXT
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "데이터 사용 정책 확인이 필요합니다. 설정 화면에서 유료 등급 키와 제공자 정책을 확인하세요.",
        )


def _runtime(
    session: Session,
    store: CredentialStore,
) -> tuple[str, str]:
    api_key, model = read_llm_runtime(session, store)
    if api_key is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "API 키가 설정되지 않았습니다.",
        )
    if model is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "현재 API 키에 연결된 모델을 먼저 선택하세요.",
        )
    return api_key, model


def _load_rubric(batch: ScanBatch, session: Session) -> Rubric:
    draft = session.scalar(
        select(RubricDraft).where(
            RubricDraft.assessment_id == batch.assessment_id
        )
    )
    if draft is None or not draft.confirmed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "루브릭이 확정되지 않았습니다.",
        )
    try:
        rubric = Rubric.model_validate(draft.content)
    except Exception:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "확정 루브릭 형식이 올바르지 않습니다.",
        ) from None
    if validate_rubric(rubric):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "확정 루브릭 구조가 채점 계약을 만족하지 않습니다.",
        )

    assessment = session.get(Assessment, batch.assessment_id)
    if assessment is None or (
        rubric.assessment.title != assessment.title
        or rubric.assessment.subject != assessment.subject
        or rubric.assessment.grade != assessment.grade
        or rubric.assessment.total_points != assessment.total_points
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "확정 루브릭과 평가 정보가 서로 다릅니다.",
        )
    return rubric


def _assert_ready_to_grade(
    batch: ScanBatch,
    session: Session,
    store: CredentialStore,
) -> tuple[Rubric, str, str]:
    _assert_policy_acknowledged(session)
    api_key, model = _runtime(session, store)
    if batch.status not in {"ready", "needs_review"}:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "스캔 배치가 채점할 수 있는 상태가 아닙니다.",
        )
    submission_count = session.scalar(
        select(func.count())
        .select_from(Submission)
        .where(Submission.batch_id == batch.id)
    )
    if not submission_count:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "스캔 배치에 채점할 학생 제출이 없습니다.",
        )
    return _load_rubric(batch, session), api_key, model


def _safe_crop_bytes(raw_path: str) -> bytes:
    path = Path(raw_path)
    root = settings.data_dir / "batches"
    descriptor: int | None = None
    try:
        root_meta = os.lstat(root)
        path_meta = os.lstat(path)
        resolved_root = root.resolve(strict=True)
        resolved_parent = path.parent.resolve(strict=True)
        if (
            not stat.S_ISDIR(root_meta.st_mode)
            or stat.S_ISLNK(root_meta.st_mode)
            or not stat.S_ISREG(path_meta.st_mode)
            or stat.S_ISLNK(path_meta.st_mode)
            or not resolved_parent.is_relative_to(resolved_root)
            or not 1 <= path_meta.st_size <= MAX_CROP_BYTES
        ):
            raise OSError
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_ino != path_meta.st_ino
            or opened.st_dev != path_meta.st_dev
            or opened.st_size != path_meta.st_size
        ):
            raise OSError
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    except OSError:
        raise RuntimeError("지역 문항 크롭을 안전하게 읽지 못했습니다.") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _validate_scored_items(
    scored: list[ScoredItem],
    rubric: Rubric,
) -> None:
    if type(scored) is not list or any(type(item) is not ScoredItem for item in scored):
        raise ValueError("채점 결과 묶음이 올바르지 않습니다.")
    by_number = {item.item_no: item for item in rubric.items}
    if len(scored) != len(by_number) or {item.item_no for item in scored} != set(by_number):
        raise ValueError("채점 결과 문항이 루브릭과 다릅니다.")
    if len({item.item_no for item in scored}) != len(scored):
        raise ValueError("채점 결과 문항이 중복되었습니다.")

    for item in scored:
        rubric_item: RubricItem = by_number[item.item_no]
        score = item.proposed_score
        if (
            item.route not in {"auto", "manual"}
            or isinstance(item.confidence, bool)
            or not isinstance(item.confidence, (int, float))
            or not math.isfinite(float(item.confidence))
            or not 0.0 <= float(item.confidence) <= 1.0
            or type(item.reason) is not str
            or not 1 <= len(item.reason.strip()) <= 4_000
            or type(item.evidence) is not str
            or len(item.evidence) > 50_000
            or type(item.recognized_raw) is not str
            or len(item.recognized_raw) > 20_000
            or type(item.routing_reasons) is not list
            or any(
                type(reason) is not str or len(reason) > 1_000
                for reason in item.routing_reasons
            )
            or type(item.part_scores) is not dict
            or any(
                type(key) is not str
                or not key.strip()
                or (value is not None and (type(value) is not int or value < 0))
                for key, value in item.part_scores.items()
            )
        ):
            raise ValueError("문항 채점 결과가 올바르지 않습니다.")
        if score is None:
            if item.route == "auto" or item.matched_criterion is not None:
                raise ValueError("점수 없는 자동 채점 결과가 있습니다.")
            continue
        if type(score) is not int or not 0 <= score <= rubric_item.points:
            raise ValueError("제안 점수가 문항 배점 범위를 벗어납니다.")
        if type(item.matched_criterion) is not str:
            raise ValueError("제안 점수의 채점기준이 없습니다.")
        allowed_pairs = {
            (rule.score, rule.criterion) for rule in rubric_item.scoring
        }
        if (score, item.matched_criterion) not in allowed_pairs:
            raise ValueError("제안 점수와 루브릭 기준이 일치하지 않습니다.")


def execute_run(
    session: Session,
    run_id: int,
    store: CredentialStore | None = None,
    progress: Any | None = None,
) -> None:
    run = session.get(GradingRun, run_id)
    if run is None or run.status != "pending":
        raise RuntimeError("실행할 수 있는 대기 채점이 아닙니다.")
    run.status = "running"
    session.commit()

    try:
        credential_store = store or get_credential_store()
        batch = session.get(ScanBatch, run.batch_id)
        if batch is None:
            raise ValueError
        rubric, api_key, model = _assert_ready_to_grade(
            batch,
            session,
            credential_store,
        )

        independent_factory = sessionmaker(
            bind=session.get_bind(),
            expire_on_commit=False,
        )
        pii_provider = roster_pii_terms(independent_factory)
        gateway = TransmissionGateway(
            audit_log_path=settings.audit_log_path(),
            pii_terms_provider=pii_provider,
            provider="gemini",
        )
        llm = build_llm_provider(api_key, model, gateway)
        recognizer = GeminiRecognitionProvider(llm=llm)
        pii_terms = pii_provider()

        submissions = list(
            session.scalars(
                select(Submission)
                .where(Submission.batch_id == batch.id)
                .options(
                    selectinload(Submission.pages),
                    selectinload(Submission.item_responses),
                )
                .order_by(Submission.id)
            )
        )
        pending_scores: list[tuple[int, ScoredItem]] = []
        total = len(submissions)
        if progress is not None:
            progress(0, total, "채점을 시작합니다.")

        for index, submission in enumerate(submissions, start=1):
            _assert_policy_acknowledged(session)
            if _runtime(session, credential_store) != (api_key, model):
                raise RuntimeError("채점 중 제공자 설정이 바뀌었습니다.")
            crops = {
                response.item_no: _safe_crop_bytes(response.crop_path)
                for response in submission.item_responses
            }
            quality = min(
                (page.registration_quality for page in submission.pages),
                default=0.0,
            )
            scored = grade_one_submission(
                rubric=rubric,
                context=SubmissionContext(
                    submission_id=submission.id,
                    anonymous_token=submission.anonymous_token,
                    assignment_status=submission.assignment_status,
                    registration_quality=quality,
                    crops=crops,
                ),
                recognizer=recognizer,
                llm=llm,
                pii_terms=pii_terms,
                confidence_threshold=run.confidence_threshold,
                review_all=run.review_all,
            )
            _validate_scored_items(scored, rubric)
            pending_scores.extend((submission.id, item) for item in scored)
            if progress is not None:
                progress(index, total, f"학생 답안 {index}/{total} 채점 완료")

        for submission_id, item in pending_scores:
            session.add(
                ItemScore(
                    run_id=run.id,
                    submission_id=submission_id,
                    item_no=item.item_no,
                    proposed_score=item.proposed_score,
                    matched_criterion=item.matched_criterion,
                    evidence=item.evidence,
                    reason=item.reason,
                    confidence=item.confidence,
                    route=item.route,
                    routing_reasons=list(item.routing_reasons),
                    part_scores=dict(item.part_scores),
                    recognized_raw=item.recognized_raw,
                )
            )
        run.status = "succeeded"
        run.failure_reason = None
        session.commit()
    except Exception:  # noqa: BLE001 - 실행 상태에는 고정 문구만 남긴다
        session.rollback()
        run = session.get(GradingRun, run_id)
        if run is not None:
            session.execute(delete(ItemScore).where(ItemScore.run_id == run_id))
            run.status = "failed"
            run.failure_reason = _RUN_FAILURE
            session.commit()
        raise RuntimeError(_RUN_FAILURE) from None


def _process(payload: dict[str, Any], progress) -> dict[str, Any]:
    session = session_factory()
    try:
        run_id = payload.get("run_id")
        if type(run_id) is not int or run_id < 1:
            raise ValueError("채점 실행 입력이 올바르지 않습니다.")
        execute_run(session, run_id, progress=progress)
        return {"run_id": run_id}
    finally:
        session.close()


def _run_out(run: GradingRun, session: Session) -> RunOut:
    scores = list(
        session.scalars(select(ItemScore).where(ItemScore.run_id == run.id))
    )
    return RunOut(
        id=run.id,
        batch_id=run.batch_id,
        status=run.status,
        failure_reason=run.failure_reason,
        total_count=len(scores),
        auto_count=sum(score.route == "auto" for score in scores),
        manual_count=sum(score.route == "manual" for score in scores),
    )


@router.post("/runs", response_model=RunOut, status_code=status.HTTP_201_CREATED)
def create_run(
    payload: RunIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> RunOut:
    batch = session.get(ScanBatch, payload.batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "스캔 배치를 찾을 수 없습니다.")

    with _CREATE_RUN_LOCK:
        _assert_ready_to_grade(batch, session, store)
        active = session.scalar(
            select(func.count())
            .select_from(GradingRun)
            .where(
                GradingRun.batch_id == batch.id,
                GradingRun.status.in_({"pending", "running"}),
            )
        )
        if active:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "이 스캔 배치의 채점이 이미 진행 중입니다.",
            )

        run = GradingRun(
            batch_id=batch.id,
            status="pending",
            review_all=payload.review_all,
            confidence_threshold=payload.confidence_threshold,
        )
        session.add(run)
        session.commit()

        from app.api.scans import get_runner

        try:
            job_id = get_runner().submit(
                "grading_run",
                {"run_id": run.id},
                _process,
            )
            run.job_id = job_id
            session.commit()
        except Exception:
            session.rollback()
            current = session.get(GradingRun, run.id)
            if current is not None:
                session.delete(current)
                session.commit()
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "채점 작업을 예약하지 못했습니다.",
            ) from None

    return _run_out(run, session)


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(
    run_id: int,
    session: Session = Depends(get_session),
) -> RunOut:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채점 실행을 찾을 수 없습니다.")
    session.refresh(run)
    return _run_out(run, session)


@router.get("/runs/{run_id}/scores")
def list_scores(
    run_id: int,
    route: Annotated[Literal["auto", "manual"] | None, Query()] = None,
    session: Session = Depends(get_session),
) -> dict[str, list[ScoreOut]]:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "채점 실행을 찾을 수 없습니다.")
    query = select(ItemScore).where(ItemScore.run_id == run.id)
    if route is not None:
        query = query.where(ItemScore.route == route)
    scores = list(
        session.scalars(query.order_by(ItemScore.item_no, ItemScore.id))
    )

    rows: list[ScoreOut] = []
    for score in scores:
        submission = session.get(Submission, score.submission_id)
        student = (
            session.get(Student, submission.student_id)
            if submission is not None
            else None
        )
        if submission is None or student is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "채점 결과의 지역 학생 자료를 찾을 수 없습니다.",
            )
        rows.append(
            ScoreOut(
                id=score.id,
                submission_id=score.submission_id,
                student_name=student.name,
                item_no=score.item_no,
                proposed_score=score.proposed_score,
                final_score=score.final_score,
                confirmed=score.confirmed,
                matched_criterion=score.matched_criterion,
                evidence=score.evidence,
                reason=score.reason,
                confidence=score.confidence,
                route=score.route,
                routing_reasons=list(score.routing_reasons),
                recognized_raw=score.recognized_raw,
            )
        )
    return {"scores": rows}
