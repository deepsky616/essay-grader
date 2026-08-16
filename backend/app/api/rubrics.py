"""루브릭 초안을 만들고 선생님 검토와 확정 상태를 관리한다."""

import os
import re
import stat
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, ValidationError as PydanticValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.assessments import load_assessment
from app.api.settings import get_credential_store, read_llm_runtime
from app.config import settings
from app.db import get_session
from app.models.assessment import Assessment
from app.models.document import SourceDocument
from app.models.rubric import RubricDraft
from app.providers.credentials import CredentialStoreError
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider
from app.schemas.rubric import Rubric
from app.services.pdf_extract import extract_pdf
from app.services.rubric_compiler import (
    CompileResult,
    RubricCompileAuthority,
    compile_rubric,
)
from app.services.rubric_validator import validate_rubric
from app.services.rubric_warnings import detect_warnings


router = APIRouter(
    prefix="/api/assessments/{assessment_id}/rubric",
    tags=["rubric"],
)

COMPILE_SOURCE_KINDS = ("rubric_table", "example_answer")
_GENERATED_PDF_NAME = re.compile(r"[0-9a-f]{32}\.pdf", re.ASCII)

_NO_SOURCE_DETAIL = "채점 기준표 또는 예시 답안 PDF를 먼저 올리세요."
_NO_DRAFT_DETAIL = "아직 컴파일된 루브릭이 없습니다."
_UNSAFE_SOURCE_DETAIL = "연결된 원문 PDF를 안전하게 읽을 수 없습니다."
_PDF_READ_DETAIL = "연결된 원문 PDF를 읽지 못했습니다."
_COMPILE_FAILED_DETAIL = "루브릭 초안을 만들지 못했습니다."
_CONFIRMED_DETAIL = (
    "확정된 루브릭은 바꿀 수 없습니다. 확정을 먼저 해제하세요."
)
_INVALID_CONFIRM_DETAIL = "루브릭 오류를 먼저 해결해야 확정할 수 있습니다."
_SAVE_FAILED_DETAIL = "루브릭 초안을 안전하게 저장하지 못했습니다."


class RubricUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rubric: dict[str, Any]


class RubricOut(BaseModel):
    rubric: dict[str, Any]
    warnings: list[dict[str, Any]]
    errors: list[str]
    confirmed: bool


def _safe_source_path(document: SourceDocument) -> Path:
    """앱이 만든 업로드 파일 한 개만 컴파일 입력으로 허용한다."""
    root = settings.uploads_dir()
    candidate = Path(document.stored_path)
    try:
        root_metadata = os.lstat(root)
        candidate_metadata = os.lstat(candidate)
        resolved_root = root.resolve(strict=True)
        resolved_parent = candidate.parent.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_UNSAFE_SOURCE_DETAIL,
        ) from None

    if (
        not candidate.is_absolute()
        or not stat.S_ISDIR(root_metadata.st_mode)
        or stat.S_ISLNK(root_metadata.st_mode)
        or resolved_parent != resolved_root
        or not _GENERATED_PDF_NAME.fullmatch(candidate.name)
        or not stat.S_ISREG(candidate_metadata.st_mode)
        or stat.S_ISLNK(candidate_metadata.st_mode)
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_UNSAFE_SOURCE_DETAIL,
        )
    return candidate


def run_compile(
    assessment: Assessment,
    documents: list[SourceDocument],
    session: Session,
) -> CompileResult:
    """지역 원문을 추출하고 단일 전송 관문을 거쳐 루브릭을 만든다."""
    paths = [_safe_source_path(document) for document in documents]
    store = get_credential_store()
    try:
        api_key, model = read_llm_runtime(session, store)
    except CredentialStoreError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API 키 저장소를 안전하게 사용할 수 없습니다.",
        ) from None
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="먼저 API 키를 입력하세요.",
        )
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="현재 API 키로 사용할 모형을 먼저 고르세요.",
        )

    try:
        authority = RubricCompileAuthority.from_assessment(assessment)
        extracts = [extract_pdf(path) for path in paths]
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=_PDF_READ_DETAIL,
        ) from None

    gateway = TransmissionGateway(
        audit_log_path=settings.audit_log_path(),
        pii_terms_provider=set,
        provider="gemini",
    )
    try:
        provider = create_gemini_provider(
            api_key=api_key,
            model=model,
            gateway=gateway,
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="언어 모형 실행을 준비하지 못했습니다.",
        ) from None
    return compile_rubric(provider, extracts, authority)


def _load_draft(assessment_id: int, session: Session) -> RubricDraft:
    draft = session.scalar(
        select(RubricDraft).where(RubricDraft.assessment_id == assessment_id)
    )
    if draft is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_NO_DRAFT_DETAIL,
        )
    return draft


def _safe_schema_errors(error: PydanticValidationError) -> list[str]:
    """입력값이나 제공자 출력 원문을 되비추지 않는 형태 오류를 만든다."""
    errors: list[str] = []
    for detail in error.errors():
        path = ".".join(str(part) for part in detail["loc"]) or "rubric"
        errors.append(f"{path}: 형식이 올바르지 않습니다.")
    return errors


def _validate_payload(payload: dict[str, Any]) -> tuple[Rubric | None, list[str]]:
    try:
        rubric = Rubric.model_validate(payload)
    except PydanticValidationError as error:
        return None, _safe_schema_errors(error)
    return rubric, [error.message for error in validate_rubric(rubric)]


def _authoritative_content(
    assessment: Assessment, payload: dict[str, Any]
) -> dict[str, Any]:
    content = RubricCompileAuthority.from_assessment(assessment).overwrite_payload(
        payload
    )
    assert isinstance(content, dict)
    return content


def _response(assessment: Assessment, draft: RubricDraft) -> RubricOut:
    content = _authoritative_content(assessment, draft.content)
    rubric, errors = _validate_payload(content)
    warnings = (
        [asdict(warning) for warning in detect_warnings(rubric)]
        if rubric is not None
        else []
    )
    return RubricOut(
        rubric=content,
        warnings=warnings,
        errors=errors,
        confirmed=draft.confirmed,
    )


def _commit_or_fail(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_SAVE_FAILED_DETAIL,
        ) from None
    except SQLAlchemyError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_SAVE_FAILED_DETAIL,
        ) from None


@router.post("/compile", response_model=RubricOut)
def compile_endpoint(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    if assessment.status == "confirmed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_CONFIRMED_DETAIL,
        )
    documents = list(
        session.scalars(
            select(SourceDocument)
            .where(
                SourceDocument.assessment_id == assessment_id,
                SourceDocument.kind.in_(COMPILE_SOURCE_KINDS),
            )
            .order_by(SourceDocument.id)
        ).all()
    )
    if not documents:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_NO_SOURCE_DETAIL,
        )

    result = run_compile(assessment, documents, session)
    if result.rubric is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=_COMPILE_FAILED_DETAIL,
        )

    content = result.rubric.model_dump(mode="json")
    warnings = [asdict(warning) for warning in result.warnings]
    draft = session.scalar(
        select(RubricDraft).where(RubricDraft.assessment_id == assessment_id)
    )
    if draft is None:
        draft = RubricDraft(
            assessment_id=assessment_id,
            content=content,
            warnings=warnings,
            confirmed=False,
        )
        session.add(draft)
    else:
        draft.content = content
        draft.warnings = warnings
        draft.confirmed = False
    assessment.status = "compiled"
    _commit_or_fail(session)
    return RubricOut(
        rubric=content,
        warnings=warnings,
        errors=list(result.errors),
        confirmed=False,
    )


@router.get("", response_model=RubricOut)
def get_rubric(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    return _response(assessment, _load_draft(assessment_id, session))


@router.put("", response_model=RubricOut)
def update_rubric(
    assessment_id: int,
    payload: RubricUpdate,
    session: Session = Depends(get_session),
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)
    if draft.confirmed or assessment.status == "confirmed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_CONFIRMED_DETAIL,
        )

    content = _authoritative_content(assessment, payload.rubric)
    rubric, errors = _validate_payload(content)
    if rubric is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "invalid_rubric_shape",
                "message": "루브릭 JSON 형태가 올바르지 않습니다.",
            },
        )
    draft.content = content
    draft.warnings = [asdict(warning) for warning in detect_warnings(rubric)]
    _commit_or_fail(session)
    return RubricOut(
        rubric=dict(draft.content),
        warnings=list(draft.warnings),
        errors=errors,
        confirmed=False,
    )


@router.post("/confirm", response_model=RubricOut)
def confirm_rubric(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)
    content = _authoritative_content(assessment, draft.content)
    _, errors = _validate_payload(content)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_INVALID_CONFIRM_DETAIL,
        )
    draft.content = content
    draft.confirmed = True
    assessment.status = "confirmed"
    _commit_or_fail(session)
    return RubricOut(
        rubric=dict(draft.content),
        warnings=list(draft.warnings),
        errors=[],
        confirmed=True,
    )


@router.post("/unconfirm", response_model=RubricOut)
def unconfirm_rubric(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> RubricOut:
    assessment = load_assessment(assessment_id, session)
    draft = _load_draft(assessment_id, session)
    draft.confirmed = False
    assessment.status = "compiled"
    _commit_or_fail(session)
    return _response(assessment, draft)
