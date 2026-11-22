"""평가 원문 PDF를 로컬 전용 저장소에 안전하게 보관한다."""

import os
import stat
import uuid
from pathlib import Path

import fitz
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.assessments import load_assessment
from app.config import settings
from app.db import get_session
from app.models.document import SourceDocument


router = APIRouter(
    prefix="/api/assessments/{assessment_id}/documents",
    tags=["documents"],
)

ALLOWED_KINDS = frozenset({"rubric_table", "example_answer", "answer_sheet"})
MAX_PDF_BYTES = 25 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024

_UNKNOWN_KIND_DETAIL = "알 수 없는 문서 종류입니다."
_INVALID_PDF_DETAIL = "올바른 PDF 파일만 올릴 수 있습니다."
_ENCRYPTED_PDF_DETAIL = "암호화되지 않은 PDF 파일만 올릴 수 있습니다."
_OVERSIZED_DETAIL = "PDF 파일 크기 제한을 넘었습니다."
_UNSAFE_STORAGE_DETAIL = "로컬 문서 저장소를 안전하게 사용할 수 없습니다."
_WRITE_FAILURE_DETAIL = "PDF 파일을 안전하게 저장하지 못했습니다."
_DATABASE_FAILURE_DETAIL = "자료 무결성 제약으로 문서를 저장하지 못했습니다."


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    filename: str
    page_count: int


def _upload_directory() -> Path:
    directory = settings.uploads_dir()
    try:
        metadata = os.lstat(directory)
    except (OSError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_UNSAFE_STORAGE_DETAIL,
        ) from None
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_UNSAFE_STORAGE_DETAIL,
        )
    return directory


def _display_filename(filename: str | None) -> str:
    candidate = (filename or "upload.pdf").replace("\\", "/").rsplit("/", 1)[-1]
    candidate = candidate.strip() or "upload.pdf"
    if len(candidate) > 300 or any(ord(character) < 32 for character in candidate):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="파일 이름이 올바르지 않습니다.",
        )
    return candidate


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise OSError("파일 쓰기가 진행되지 않았습니다.")
        offset += written


def _remove_generated(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # 생성한 임시 파일만 대상으로 하며, 실패를 숨긴 채 더 넓은 경로를
        # 지우거나 강한 삭제 수단으로 다시 시도하지 않는다.
        pass


def _stream_to_private_file(file: UploadFile, directory: Path) -> Path:
    temporary = directory / f".upload-{uuid.uuid4().hex}.pdf"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    total = 0
    completed = False
    try:
        descriptor = os.open(temporary, flags, 0o600)
        while True:
            chunk = file.file.read(_READ_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_PDF_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=_OVERSIZED_DETAIL,
                )
            _write_all(descriptor, chunk)
        os.fsync(descriptor)
        completed = True
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_WRITE_FAILURE_DETAIL,
        ) from None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if not completed or total == 0:
            _remove_generated(temporary)

    if total == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_INVALID_PDF_DETAIL,
        )
    return temporary


def _inspect_pdf(path: Path) -> int:
    try:
        with fitz.open(path) as document:
            if document.needs_pass:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=_ENCRYPTED_PDF_DETAIL,
                )
            page_count = document.page_count
            if page_count < 1 or not document.is_pdf:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=_INVALID_PDF_DETAIL,
                )
            return page_count
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_INVALID_PDF_DETAIL,
        ) from None


def _publish_file(temporary: Path, directory: Path) -> Path:
    final_path = directory / f"{uuid.uuid4().hex}.pdf"
    try:
        os.replace(temporary, final_path)
        directory_descriptor = os.open(
            directory,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError:
        _remove_generated(temporary)
        _remove_generated(final_path)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_WRITE_FAILURE_DETAIL,
        ) from None
    return final_path


@router.post("", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
def upload_document(
    assessment_id: int,
    kind: str = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> SourceDocument:
    load_assessment(assessment_id, session)
    if kind not in ALLOWED_KINDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_UNKNOWN_KIND_DETAIL,
        )

    filename = _display_filename(file.filename)
    directory = _upload_directory()
    temporary: Path | None = None
    final_path: Path | None = None
    try:
        temporary = _stream_to_private_file(file, directory)
        page_count = _inspect_pdf(temporary)
        final_path = _publish_file(temporary, directory)
        temporary = None

        record = SourceDocument(
            assessment_id=assessment_id,
            kind=kind,
            filename=filename,
            stored_path=str(final_path),
            page_count=page_count,
        )
        session.add(record)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_DATABASE_FAILURE_DETAIL,
            ) from None
        except SQLAlchemyError:
            session.rollback()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="문서 정보를 저장하지 못했습니다.",
            ) from None
        return record
    except HTTPException:
        _remove_generated(temporary)
        _remove_generated(final_path)
        raise
    except Exception:
        session.rollback()
        _remove_generated(temporary)
        _remove_generated(final_path)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_WRITE_FAILURE_DETAIL,
        ) from None


@router.get("", response_model=list[DocumentOut])
def list_documents(
    assessment_id: int,
    session: Session = Depends(get_session),
) -> list[SourceDocument]:
    load_assessment(assessment_id, session)
    return list(
        session.scalars(
            select(SourceDocument)
            .where(SourceDocument.assessment_id == assessment_id)
            .order_by(SourceDocument.id)
        ).all()
    )
