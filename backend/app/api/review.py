from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.models.assessment import Assessment
from app.models.classroom import Student
from app.models.grading import GradingRun, ItemScore
from app.models.review import ScoreRevision
from app.models.rubric import RubricDraft
from app.models.scan import ItemResponse, ScanBatch, Submission
from app.schemas.rubric import Rubric, RubricItem
from app.services.accuracy import compute_accuracy
from app.services.confirmation import (
    ConfirmationError,
    bulk_accept_auto,
    confirm_score,
    submission_total,
)
from app.services.rubric_validator import validate_rubric
from app.services.safe_files import read_safe_regular_file


router = APIRouter(prefix="/api/review", tags=["review"])
MAX_REVIEW_IMAGE_BYTES = 20 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ConfirmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: Annotated[int, Field(strict=True, ge=0)]
    note: Annotated[
        str,
        Field(strict=True),
        StringConstraints(strip_whitespace=True, min_length=1, max_length=4000),
    ] | None = None


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
            "성공한 채점 실행만 검토할 수 있습니다.",
        )
    return run


def _load_score(score_id: int, session: Session) -> ItemScore:
    score = session.get(ItemScore, score_id)
    if score is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "채점 결과를 찾을 수 없습니다.",
        )
    return score


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
            "확정 루브릭 구조가 검토 계약을 만족하지 않습니다.",
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


def _find_item(rubric: Rubric, item_no: int) -> RubricItem:
    for item in rubric.items:
        if item.item_no == item_no:
            return item
    raise HTTPException(
        status.HTTP_404_NOT_FOUND,
        f"루브릭에 {item_no}번 문항이 없습니다.",
    )


def _score_row(score: ItemScore, session: Session) -> dict[str, Any]:
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
    return {
        "id": score.id,
        "submission_id": score.submission_id,
        "student_number": student.number,
        "student_name": student.name,
        "item_no": score.item_no,
        "proposed_score": score.proposed_score,
        "final_score": score.final_score,
        "confirmed": score.confirmed,
        "matched_criterion": score.matched_criterion,
        "evidence": score.evidence,
        "reason": score.reason,
        "confidence": score.confidence,
        "route": score.route,
        "routing_reasons": list(score.routing_reasons),
        "recognized_raw": score.recognized_raw,
        "part_scores": dict(score.part_scores),
    }


@router.get("/runs/{run_id}/queue")
def get_queue(
    run_id: int,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    scores = session.scalars(
        select(ItemScore)
        .where(ItemScore.run_id == run_id)
        .order_by(ItemScore.item_no, ItemScore.id)
    ).all()

    groups: list[dict[str, Any]] = []
    for item in rubric.items:
        item_scores = [score for score in scores if score.item_no == item.item_no]
        groups.append(
            {
                "item_no": item.item_no,
                "title": item.title,
                "points": item.points,
                "type": item.type.value,
                "total": len(item_scores),
                "pending": sum(not score.confirmed for score in item_scores),
                "manual": sum(score.route == "manual" for score in item_scores),
                "scoring": [
                    {"score": rule.score, "criterion": rule.criterion}
                    for rule in item.scoring
                ],
            }
        )
    return {"run_id": run_id, "items": groups}


@router.get("/runs/{run_id}/items/{item_no}")
def get_item_scores(
    run_id: int,
    item_no: int,
    pending_only: bool = False,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    run = _load_run(run_id, session)
    item = _find_item(_load_rubric(run, session), item_no)
    query = select(ItemScore).where(
        ItemScore.run_id == run_id,
        ItemScore.item_no == item_no,
    )
    if pending_only:
        query = query.where(ItemScore.confirmed.is_(False))
    scores = session.scalars(query.order_by(ItemScore.id)).all()
    rows = sorted(
        (_score_row(score, session) for score in scores),
        key=lambda row: (row["student_number"], row["submission_id"]),
    )
    return {
        "item_no": item.item_no,
        "title": item.title,
        "points": item.points,
        "type": item.type.value,
        "example_answer": item.example_answer,
        "scoring": [
            {"score": rule.score, "criterion": rule.criterion}
            for rule in item.scoring
        ],
        "scores": rows,
    }


@router.post("/scores/{score_id}/confirm")
def confirm(
    score_id: int,
    payload: ConfirmIn,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    score = _load_score(score_id, session)
    run = _load_run(score.run_id, session)
    item = _find_item(_load_rubric(run, session), score.item_no)
    source = (
        "teacher_accept"
        if payload.score == score.proposed_score
        else "teacher_edit"
    )
    try:
        confirm_score(
            session,
            score,
            new_score=payload.score,
            source=source,
            note=payload.note,
            max_points=item.points,
        )
    except ConfirmationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _score_row(score, session)


@router.get("/scores/{score_id}/history")
def get_history(
    score_id: int,
    session: Session = Depends(get_session),
) -> dict[str, list[dict[str, Any]]]:
    _load_score(score_id, session)
    revisions = session.scalars(
        select(ScoreRevision)
        .where(ScoreRevision.item_score_id == score_id)
        .order_by(ScoreRevision.id)
    ).all()
    return {
        "revisions": [
            {
                "id": revision.id,
                "previous_score": revision.previous_score,
                "new_score": revision.new_score,
                "source": revision.source,
                "actor": revision.actor,
                "note": revision.note,
                "created_at": revision.created_at.isoformat(),
            }
            for revision in revisions
        ]
    }


@router.get("/scores/{score_id}/crop")
def get_crop(
    score_id: int,
    session: Session = Depends(get_session),
) -> Response:
    score = _load_score(score_id, session)
    response_row = session.scalar(
        select(ItemResponse).where(
            ItemResponse.submission_id == score.submission_id,
            ItemResponse.item_no == score.item_no,
        )
    )
    if response_row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "문항 크롭 이미지를 찾을 수 없습니다.",
        )
    try:
        content = read_safe_regular_file(
            response_row.crop_path,
            root=settings.data_dir / "batches",
            max_bytes=MAX_REVIEW_IMAGE_BYTES,
        )
    except RuntimeError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "문항 크롭 이미지를 안전하게 읽을 수 없습니다.",
        ) from None
    if not content.startswith(PNG_SIGNATURE):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "문항 크롭 이미지 형식이 올바르지 않습니다.",
        )
    return Response(
        content=content,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/runs/{run_id}/bulk-accept")
def bulk_accept(
    run_id: int,
    session: Session = Depends(get_session),
) -> dict[str, int]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    points_by_item = {item.item_no: item.points for item in rubric.items}
    candidates = session.scalars(
        select(ItemScore).where(
            ItemScore.run_id == run_id,
            ItemScore.route == "auto",
            ItemScore.confirmed.is_(False),
            ItemScore.proposed_score.is_not(None),
        )
    ).all()
    for score in candidates:
        max_points = points_by_item.get(score.item_no)
        if max_points is None or (
            score.proposed_score is not None
            and score.proposed_score > max_points
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "제안 점수가 문항 배점 계약을 만족하지 않습니다.",
            )
    return {"accepted": bulk_accept_auto(session, run_id)}


@router.get("/runs/{run_id}/progress")
def get_progress(
    run_id: int,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    _load_run(run_id, session)
    scores = session.scalars(
        select(ItemScore).where(ItemScore.run_id == run_id)
    ).all()
    confirmed = sum(score.confirmed for score in scores)
    return {
        "total": len(scores),
        "confirmed": confirmed,
        "pending": len(scores) - confirmed,
        "complete": bool(scores) and confirmed == len(scores),
    }


@router.get("/runs/{run_id}/totals")
def get_totals(
    run_id: int,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    run = _load_run(run_id, session)
    submissions = session.scalars(
        select(Submission).where(Submission.batch_id == run.batch_id)
    ).all()
    rows: list[dict[str, Any]] = []
    for submission in submissions:
        student = session.get(Student, submission.student_id)
        if student is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "제출의 지역 학생 자료를 찾을 수 없습니다.",
            )
        total = submission_total(
            session,
            submission.id,
            run_id=run_id,
        )
        rows.append(
            {
                "submission_id": submission.id,
                "student_number": student.number,
                "student_name": student.name,
                "total": total.points,
                "confirmed": total.confirmed,
                "pending": total.pending,
                "complete": total.complete,
            }
        )
    rows.sort(key=lambda row: (row["student_number"], row["submission_id"]))
    return {"students": rows}


@router.get("/runs/{run_id}/accuracy")
def get_accuracy(
    run_id: int,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    run = _load_run(run_id, session)
    rubric = _load_rubric(run, session)
    item_types = {item.item_no: item.type.value for item in rubric.items}
    report = compute_accuracy(session, run_id, item_types)
    return {
        "by_item": [
            {
                "item_no": row.item_no,
                "item_type": row.item_type,
                "confirmed": row.confirmed,
                "agreed": row.agreed,
                "agreement_rate": row.agreement_rate,
            }
            for row in report.by_item
        ],
        "by_type": {
            name: {
                "confirmed": row.confirmed,
                "agreed": row.agreed,
                "agreement_rate": row.agreement_rate,
            }
            for name, row in report.by_type.items()
        },
        "auto_route_confirmed": report.auto_route_confirmed,
        "auto_route_disagreements": report.auto_route_disagreements,
        "auto_route_is_safe": report.auto_route_is_safe,
    }
