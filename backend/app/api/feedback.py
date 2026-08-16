from collections.abc import Iterable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.settings import get_credential_store, read_llm_runtime, read_setting
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
from app.models.feedback import Feedback
from app.models.grading import GradingRun
from app.models.rubric import RubricDraft
from app.models.scan import ScanBatch, Submission
from app.providers.base import LLMProvider
from app.providers.credentials import CredentialStore
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider
from app.providers.pii_terms import roster_pii_terms
from app.schemas.rubric import Rubric
from app.services.export_excel import build_gradebook
from app.services.feedback_builder import (
    FeedbackContext,
    NotConfirmed,
    build_contexts,
    feedback_source_digest,
)
from app.services.feedback_generator import GeneratedFeedback, generate_feedback
from app.services.feedback_render import render_all
from app.services.rubric_validator import validate_rubric
from app.services.sanitize import mask_personal_names


router = APIRouter(prefix="/api/feedback", tags=["feedback"])


def build_feedback_provider(api_key: str, model: str) -> LLMProvider:
    gateway = TransmissionGateway(
        audit_log_path=settings.audit_log_path(),
        pii_terms_provider=roster_pii_terms(session_factory),
        provider="gemini",
    )
    return create_gemini_provider(api_key=api_key, model=model, gateway=gateway)


def generate_one(
    context: FeedbackContext,
    provider: LLMProvider,
    pii_terms: set[str],
) -> GeneratedFeedback:
    return generate_feedback(context, provider, pii_terms=pii_terms)


def _load_run(run_id: int, session: Session) -> GradingRun:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "채점 실행을 찾을 수 없습니다.",
        )
    if run.status != "succeeded":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "성공한 채점 실행만 피드백을 만들 수 있습니다.",
        )
    return run


def _load_rubric(run: GradingRun, session: Session) -> Rubric:
    batch = session.get(ScanBatch, run.batch_id)
    if batch is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "채점 실행의 스캔 배치를 찾을 수 없습니다.",
        )
    draft = session.scalar(
        select(RubricDraft).where(
            RubricDraft.assessment_id == batch.assessment_id
        )
    )
    if draft is None or not draft.confirmed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "확정 루브릭을 찾을 수 없습니다.",
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
            "확정 루브릭 구조가 피드백 계약을 만족하지 않습니다.",
        )
    assessment = session.get(Assessment, batch.assessment_id)
    if assessment is None or (
        rubric.assessment.title != assessment.title
        or rubric.assessment.subject != assessment.subject
        or rubric.assessment.grade != assessment.grade
        or rubric.assessment.total_points != assessment.total_points
        or dict(rubric.level_cutoffs) != dict(assessment.level_cutoffs)
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "확정 루브릭과 평가 정보가 서로 다릅니다.",
        )
    return rubric


def _contexts_or_400(
    session: Session,
    run_id: int,
    rubric: Rubric,
) -> list[FeedbackContext]:
    try:
        return build_contexts(session, run_id, rubric)
    except NotConfirmed as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


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
            "데이터 사용 정책 확인이 필요합니다. 설정 화면에서 다시 확인하세요.",
        )


def _required_runtime(
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


def _current_pii_terms(session: Session) -> set[str]:
    return {
        name.strip()
        for name in session.scalars(select(Student.name)).all()
        if name and len(name.strip()) >= 2
    }


def _digest_map(contexts: Iterable[FeedbackContext]) -> dict[int, str]:
    return {
        context.submission_id: feedback_source_digest(context)
        for context in contexts
    }


def _validated_generated(
    context: FeedbackContext,
    generated: GeneratedFeedback,
    pii_terms: set[str],
) -> GeneratedFeedback:
    if type(generated) is not GeneratedFeedback or type(generated.degraded) is not bool:
        raise ValueError("피드백 결과 자료형이 올바르지 않습니다.")
    if type(generated.item_comments) is not list:
        raise ValueError("피드백 문항 설명이 목록이 아닙니다.")
    expected = {
        item.item_no: (item.score, item.max_points) for item in context.items
    }
    comments: list[dict[str, Any]] = []
    seen: set[int] = set()
    for row in generated.item_comments:
        if type(row) is not dict or set(row) != {"item_no", "score", "max", "comment"}:
            raise ValueError("피드백 문항 설명 형식이 올바르지 않습니다.")
        item_no = row["item_no"]
        score = row["score"]
        max_points = row["max"]
        comment_value = row["comment"]
        if (
            type(item_no) is not int
            or item_no in seen
            or expected.get(item_no) != (score, max_points)
            or not isinstance(comment_value, str)
        ):
            raise ValueError("피드백 문항 설명이 확정 점수와 다릅니다.")
        comment, _ = mask_personal_names(comment_value, pii_terms)
        comment = comment.replace(context.anonymous_token, "학생").strip()
        if not 1 <= len(comment) <= 4_000:
            raise ValueError("피드백 문항 설명 길이가 올바르지 않습니다.")
        seen.add(item_no)
        comments.append(
            {
                "item_no": item_no,
                "score": score,
                "max": max_points,
                "comment": comment,
            }
        )
    if seen != set(expected):
        raise ValueError("피드백 문항 설명이 완전하지 않습니다.")
    if not isinstance(generated.summary, str) or not isinstance(generated.next_step, str):
        raise ValueError("피드백 총평 형식이 올바르지 않습니다.")
    summary, _ = mask_personal_names(generated.summary, pii_terms)
    next_step, _ = mask_personal_names(generated.next_step, pii_terms)
    summary = summary.replace(context.anonymous_token, "학생").strip()
    next_step = next_step.replace(context.anonymous_token, "학생").strip()
    if not 1 <= len(summary) <= 10_000 or not 1 <= len(next_step) <= 10_000:
        raise ValueError("피드백 총평 길이가 올바르지 않습니다.")
    return GeneratedFeedback(
        item_comments=comments,
        summary=summary,
        next_step=next_step,
        degraded=generated.degraded,
    )


@router.post("/runs/{run_id}/generate")
def generate(
    run_id: int,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> dict[str, int]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    contexts = _contexts_or_400(session, run_id, rubric)
    _assert_policy_acknowledged(session)
    api_key, model = _required_runtime(session, store)
    try:
        provider = build_feedback_provider(api_key, model)
    except Exception:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "피드백 제공자를 안전하게 준비하지 못했습니다.",
        ) from None
    pii_terms = _current_pii_terms(session)
    initial_digests = _digest_map(contexts)

    generated_rows: list[tuple[FeedbackContext, GeneratedFeedback]] = []
    try:
        for context in contexts:
            session.expire_all()
            _assert_policy_acknowledged(session)
            if _required_runtime(session, store) != (api_key, model):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "피드백 생성 중 API 키나 모델 설정이 바뀌었습니다.",
                )
            generated_rows.append(
                (
                    context,
                    _validated_generated(
                        context,
                        generate_one(context, provider, pii_terms),
                        pii_terms,
                    ),
                )
            )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "피드백 생성 결과를 안전하게 처리하지 못했습니다.",
        ) from None

    session.rollback()
    refreshed_run = _load_run(run_id, session)
    refreshed_rubric = _load_rubric(refreshed_run, session)
    refreshed_contexts = _contexts_or_400(session, run_id, refreshed_rubric)
    if _digest_map(refreshed_contexts) != initial_digests:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "피드백 생성 중 확정 점수나 루브릭이 바뀌었습니다. 다시 생성하세요.",
        )
    _assert_policy_acknowledged(session)
    if _required_runtime(session, store) != (api_key, model):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "피드백 생성 중 API 키나 모델 설정이 바뀌었습니다.",
        )

    session.execute(delete(Feedback).where(Feedback.run_id == run_id))
    for context, generated in generated_rows:
        session.add(
            Feedback(
                run_id=run_id,
                submission_id=context.submission_id,
                total_score=context.total_score,
                level=context.level,
                degraded=generated.degraded,
                source_digest=initial_digests[context.submission_id],
                item_comments=generated.item_comments,
                summary=generated.summary,
                next_step=generated.next_step,
            )
        )
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "피드백을 원자적으로 저장하지 못했습니다. 다시 시도하세요.",
        ) from None
    return {
        "generated": len(generated_rows),
        "degraded": sum(generated.degraded for _, generated in generated_rows),
    }


def _current_context_map(
    session: Session,
    run_id: int,
    rubric: Rubric,
) -> dict[int, FeedbackContext] | None:
    try:
        contexts = build_contexts(session, run_id, rubric)
    except NotConfirmed:
        return None
    return {context.submission_id: context for context in contexts}


@router.get("/runs/{run_id}")
def list_feedback(
    run_id: int,
    session: Session = Depends(get_session),
) -> dict[str, list[dict[str, Any]]]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    contexts = _current_context_map(session, run_id, rubric)
    feedbacks = session.scalars(
        select(Feedback)
        .where(Feedback.run_id == run_id)
        .order_by(Feedback.id)
    ).all()
    rows: list[dict[str, Any]] = []
    for feedback in feedbacks:
        submission = session.get(Submission, feedback.submission_id)
        student = (
            session.get(Student, submission.student_id)
            if submission is not None
            else None
        )
        if submission is None or student is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "피드백의 지역 학생 자료를 찾을 수 없습니다.",
            )
        context = contexts.get(feedback.submission_id) if contexts else None
        stale = (
            context is None
            or feedback.source_digest != feedback_source_digest(context)
        )
        rows.append(
            {
                "id": feedback.id,
                "student_number": student.number,
                "student_name": student.name,
                "total_score": feedback.total_score,
                "level": feedback.level,
                "degraded": feedback.degraded,
                "stale": stale,
                "item_comments": list(feedback.item_comments),
                "summary": feedback.summary,
                "next_step": feedback.next_step,
            }
        )
    rows.sort(key=lambda row: (row["student_number"], row["id"]))
    return {"feedbacks": rows}


def _pairs(
    session: Session,
    run_id: int,
    rubric: Rubric,
) -> list[tuple[FeedbackContext, GeneratedFeedback]]:
    contexts = _contexts_or_400(session, run_id, rubric)
    feedbacks = {
        feedback.submission_id: feedback
        for feedback in session.scalars(
            select(Feedback).where(Feedback.run_id == run_id)
        ).all()
    }
    if not feedbacks:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "아직 피드백을 생성하지 않았습니다.",
        )
    if set(feedbacks) != {context.submission_id for context in contexts}:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "학생별 피드백이 완전하지 않습니다. 다시 생성하세요.",
        )

    pairs: list[tuple[FeedbackContext, GeneratedFeedback]] = []
    for context in contexts:
        feedback = feedbacks[context.submission_id]
        if feedback.source_digest != feedback_source_digest(context):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "확정 점수나 루브릭이 바뀌어 피드백이 오래됐습니다. 다시 생성하세요.",
            )
        pairs.append(
            (
                context,
                GeneratedFeedback(
                    item_comments=list(feedback.item_comments),
                    summary=feedback.summary,
                    next_step=feedback.next_step,
                    degraded=feedback.degraded,
                ),
            )
        )
    return pairs


@router.get("/runs/{run_id}/export.html")
def export_html(
    run_id: int,
    session: Session = Depends(get_session),
) -> Response:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    html = render_all(
        _pairs(session, run_id, rubric),
        title=rubric.assessment.title,
    )
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/runs/{run_id}/export.xlsx")
def export_excel(
    run_id: int,
    session: Session = Depends(get_session),
) -> Response:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    contexts = _contexts_or_400(session, run_id, rubric)
    data = build_gradebook(contexts, title=rubric.assessment.title)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="gradebook.xlsx"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
