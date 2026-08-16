from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_session
from app.models.assessment import Assessment
from app.models.document import SourceDocument
from app.schemas.assessment import AssessmentCreate, AssessmentOut, AssessmentUpdate
from app.services.rubric_validator import validate_level_cutoffs


router = APIRouter(prefix="/api/assessments", tags=["assessments"])

_INTEGRITY_ERROR_DETAIL = "자료 무결성 제약으로 요청을 처리할 수 없습니다."
_LOCAL_FILES_BLOCK_DELETE_DETAIL = (
    "연결된 로컬 문서 파일을 먼저 안전하게 정리해야 합니다."
)


def load_assessment(assessment_id: int, session: Session) -> Assessment:
    assessment = session.get(Assessment, assessment_id)
    if assessment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="평가를 찾을 수 없습니다.",
        )
    return assessment


def _commit_or_conflict(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_INTEGRITY_ERROR_DETAIL,
        ) from None


def _validate_cutoffs(total_points: int, level_cutoffs: dict[str, int]) -> None:
    errors = validate_level_cutoffs(total_points, level_cutoffs)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "invalid_level_cutoffs",
                "message": errors[0].message,
            },
        )


def _path_may_exist(stored_path: str) -> bool:
    path = Path(stored_path)
    try:
        return path.exists() or path.is_symlink()
    except (OSError, ValueError):
        return True


@router.post("", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def create_assessment(
    payload: AssessmentCreate,
    session: Session = Depends(get_session),
) -> Assessment:
    _validate_cutoffs(payload.total_points, payload.level_cutoffs)
    assessment = Assessment(**payload.model_dump(mode="json"))
    session.add(assessment)
    _commit_or_conflict(session)
    return assessment


@router.get("", response_model=list[AssessmentOut])
def list_assessments(
    session: Session = Depends(get_session),
) -> list[Assessment]:
    return list(
        session.scalars(select(Assessment).order_by(Assessment.id.desc())).all()
    )


@router.get("/{assessment_id}", response_model=AssessmentOut)
def get_assessment(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> Assessment:
    return load_assessment(assessment_id, session)


@router.patch("/{assessment_id}", response_model=AssessmentOut)
def update_assessment(
    assessment_id: int,
    payload: AssessmentUpdate,
    session: Session = Depends(get_session),
) -> Assessment:
    assessment = load_assessment(assessment_id, session)
    changes = payload.model_dump(exclude_unset=True, mode="json")
    proposed_total = changes.get("total_points", assessment.total_points)
    proposed_cutoffs = changes.get("level_cutoffs", assessment.level_cutoffs)
    _validate_cutoffs(proposed_total, proposed_cutoffs)

    for field_name, value in changes.items():
        setattr(assessment, field_name, value)

    _commit_or_conflict(session)
    return assessment


@router.delete("/{assessment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_assessment(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> Response:
    assessment = load_assessment(assessment_id, session)
    stored_paths = session.scalars(
        select(SourceDocument.stored_path).where(
            SourceDocument.assessment_id == assessment_id
        )
    )
    if any(_path_may_exist(stored_path) for stored_path in stored_paths):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_LOCAL_FILES_BLOCK_DELETE_DETAIL,
        )

    session.delete(assessment)
    _commit_or_conflict(session)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
