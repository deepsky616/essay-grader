import os
from pathlib import Path
import secrets
import shutil
import stat
from typing import Annotated, Any
import uuid

import cv2
import fitz
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app.api.assessments import load_assessment
from app.config import settings
from app.db import get_session, session_factory
from app.jobs.runner import JobRunner, ProgressFn
from app.models.classroom import Classroom, Student
from app.models.document import SourceDocument
from app.models.scan import ItemResponse, PageImage, ScanBatch, Submission
from app.models.sheet_template import SheetTemplate
from app.providers.local_ocr import TesseractLocalOCR
from app.services.cropper import CropSpec, Rect
from app.services.scan_pipeline import (
    PipelineOutcome,
    PipelineResult,
    StudentResult,
    process_batch_pages,
)


router = APIRouter(prefix="/api/scans", tags=["scans"])

TEMPLATE_DPI = 200
MAX_SCAN_PDF_BYTES = 100 * 1024 * 1024
MAX_SCAN_PAGES = 5_000
MAX_RENDER_VALUES = 500_000_000
_READ_CHUNK = 1024 * 1024
_FAILED_REASON = "스캔 배치 처리 중 오류가 발생했습니다."
_INVALID_SCAN = "올바른 스캔 PDF 파일만 올릴 수 있습니다."

_runner: JobRunner | Any | None = None


class BatchOut(BaseModel):
    id: int
    status: str
    failure_reason: str | None
    submission_count: int
    review_count: int


class ReassignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    student_id: Annotated[StrictInt, Field(ge=1)]


def get_runner() -> JobRunner:
    global _runner
    if _runner is None:
        _runner = JobRunner(session_factory=session_factory)
    return _runner


def run_pipeline(**kwargs: Any) -> PipelineResult:
    return process_batch_pages(**kwargs)


def _safe_uploads_directory() -> Path:
    directory = settings.uploads_dir()
    try:
        metadata = os.lstat(directory)
    except OSError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "로컬 스캔 저장소를 안전하게 사용할 수 없습니다.",
        ) from None
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "로컬 스캔 저장소를 안전하게 사용할 수 없습니다.",
        )
    return directory


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise OSError
        offset += written


def _remove_file(path: Path | None) -> None:
    if path is None:
        return
    try:
        metadata = os.lstat(path)
        if stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
            path.unlink()
    except OSError:
        pass


def _inspect_scan_pdf(path: Path) -> int:
    try:
        with fitz.open(path) as document:
            if document.needs_pass or not document.is_pdf:
                raise ValueError
            if not 1 <= document.page_count <= MAX_SCAN_PAGES:
                raise ValueError
            return document.page_count
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _INVALID_SCAN) from None


def _store_scan_pdf(file: UploadFile) -> tuple[Path, int]:
    directory = _safe_uploads_directory()
    temporary = directory / f".scan-{uuid.uuid4().hex}.pdf"
    final: Path | None = None
    descriptor: int | None = None
    total = 0
    completed = False
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        descriptor = os.open(temporary, flags, 0o600)
        while True:
            chunk = file.file.read(_READ_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_SCAN_PDF_BYTES:
                raise HTTPException(
                    status.HTTP_413_CONTENT_TOO_LARGE,
                    "스캔 PDF 파일 크기 제한을 넘었습니다.",
                )
            _write_all(descriptor, chunk)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        if total == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, _INVALID_SCAN)
        page_count = _inspect_scan_pdf(temporary)
        final = directory / f"scan-{uuid.uuid4().hex}.pdf"
        os.replace(temporary, final)
        os.chmod(final, 0o600)
        completed = True
        return final, page_count
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "스캔 PDF를 안전하게 저장하지 못했습니다.",
        ) from None
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        _remove_file(temporary)
        if final is not None and not completed:
            _remove_file(final)


def _safe_local_pdf(raw_path: str) -> Path:
    path = Path(raw_path)
    uploads = _safe_uploads_directory()
    try:
        metadata = os.lstat(path)
        parent = path.parent.resolve(strict=True)
        root = uploads.resolve(strict=True)
    except OSError:
        raise ValueError("지역 PDF 파일을 안전하게 열 수 없습니다.") from None
    if (
        parent != root
        or not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or not 1 <= metadata.st_size <= MAX_SCAN_PDF_BYTES
    ):
        raise ValueError("지역 PDF 파일을 안전하게 열 수 없습니다.")
    return path


def pdf_to_gray_pages(path: Path) -> list[np.ndarray]:
    safe = _safe_local_pdf(str(path))
    pages: list[np.ndarray] = []
    total_values = 0
    try:
        with fitz.open(safe) as document:
            if document.needs_pass or not 1 <= document.page_count <= MAX_SCAN_PAGES:
                raise ValueError
            for page in document:
                pixmap = page.get_pixmap(dpi=TEMPLATE_DPI, alpha=False)
                values = pixmap.height * pixmap.width
                total_values += values
                if values > 40_000_000 or total_values > MAX_RENDER_VALUES:
                    raise ValueError
                array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                    pixmap.height,
                    pixmap.width,
                    pixmap.n,
                )
                if pixmap.n == 1:
                    gray = array[:, :, 0]
                else:
                    gray = cv2.cvtColor(array[:, :, :3], cv2.COLOR_RGB2GRAY)
                pages.append(np.ascontiguousarray(gray))
    except Exception:
        raise ValueError("PDF 페이지를 안전하게 렌더링하지 못했습니다.") from None
    return pages


def load_template_pages(
    template: SheetTemplate,
    session: Session,
) -> dict[int, np.ndarray]:
    document = session.get(SourceDocument, template.source_document_id)
    if document is None or document.kind != "answer_sheet":
        raise ValueError("원본 답안지 파일을 찾을 수 없습니다.")
    pages = pdf_to_gray_pages(Path(document.stored_path))
    if len(pages) != template.page_count:
        raise ValueError("원본 답안지 쪽 수가 템플릿과 다릅니다.")
    return {index + 1: page for index, page in enumerate(pages)}


def build_specs(
    template: SheetTemplate,
) -> tuple[dict[int, list[CropSpec]], tuple[int, Rect]]:
    crop_specs: dict[int, list[CropSpec]] = {}
    pii_regions = [region for region in template.regions if region.region_type == "pii"]
    if len(pii_regions) != 1:
        raise ValueError("식별정보 영역을 하나 지정해야 합니다.")
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
    if not crop_specs:
        raise ValueError("응답 영역을 하나 이상 지정해야 합니다.")
    pii = pii_regions[0]
    return crop_specs, (pii.page_no, (pii.x, pii.y, pii.width, pii.height))


def _valid_image(image: object) -> bool:
    return (
        isinstance(image, np.ndarray)
        and image.dtype == np.uint8
        and image.size > 0
        and image.size <= 100_000_000
        and (image.ndim == 2 or (image.ndim == 3 and image.shape[2] in (3, 4)))
    )


def _validate_student_result(result: StudentResult, expected_index: int) -> None:
    if (
        type(result) is not StudentResult
        or result.index != expected_index
        or type(result.page_range) is not tuple
        or len(result.page_range) != 2
        or any(type(value) is not int for value in result.page_range)
        or result.page_range[0] < 0
        or result.page_range[1] <= result.page_range[0]
        or result.assignment_status not in {"confirmed", "needs_review"}
        or (
            result.recognized_name is not None
            and (
                type(result.recognized_name) is not str
                or not 1 <= len(result.recognized_name.strip()) <= 50
            )
        )
        or (
            result.assignment_note is not None
            and (
                type(result.assignment_note) is not str
                or len(result.assignment_note) > 2000
            )
        )
    ):
        raise ValueError("파이프라인 학생 결과가 올바르지 않습니다.")
    if (
        not result.aligned_pages
        or set(result.aligned_pages) != set(result.ink_pages)
        or set(result.aligned_pages) != set(result.registration_quality)
        or not result.crops
        or set(result.crops) != set(result.ink_crops)
    ):
        raise ValueError("파이프라인 이미지 결과가 빠졌습니다.")
    for page_no, image in result.aligned_pages.items():
        quality = result.registration_quality[page_no]
        if (
            type(page_no) is not int
            or page_no < 1
            or not _valid_image(image)
            or not _valid_image(result.ink_pages[page_no])
            or type(quality) is not float
            or not 0.0 <= quality <= 1.0
        ):
            raise ValueError("파이프라인 페이지 결과가 올바르지 않습니다.")
    for item_no, image in result.crops.items():
        if (
            type(item_no) is not int
            or item_no < 1
            or not _valid_image(image)
            or not _valid_image(result.ink_crops[item_no])
        ):
            raise ValueError("파이프라인 문항 결과가 올바르지 않습니다.")


def _batches_directory() -> Path:
    data_root = settings.data_dir
    try:
        root_meta = os.lstat(data_root)
        if not stat.S_ISDIR(root_meta.st_mode) or stat.S_ISLNK(root_meta.st_mode):
            raise OSError
        directory = data_root / "batches"
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            pass
        metadata = os.lstat(directory)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise OSError
        return directory
    except OSError:
        raise RuntimeError("배치 결과 폴더를 안전하게 사용할 수 없습니다.") from None


def _remove_tree(path: Path, root: Path) -> None:
    try:
        if path.parent.resolve(strict=True) != root.resolve(strict=True):
            return
        metadata = os.lstat(path)
        if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
            shutil.rmtree(path)
    except OSError:
        pass


def _write_png(path: Path, image: np.ndarray) -> None:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("이미지를 PNG로 만들지 못했습니다.")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        _write_all(descriptor, encoded.tobytes())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def persist_result(
    session: Session,
    batch: ScanBatch,
    result: PipelineResult,
    present_students: list[Student],
) -> None:
    if type(result) is not PipelineResult or type(present_students) is not list:
        raise ValueError("파이프라인 저장 입력이 올바르지 않습니다.")
    if result.outcome is PipelineOutcome.SPLIT_FAILED:
        if result.students or not result.failure_reason:
            raise ValueError("파이프라인 분할 실패 결과가 올바르지 않습니다.")
        batch.status = "split_failed"
        batch.failure_reason = result.failure_reason[:2000]
        session.commit()
        return
    if result.outcome not in {PipelineOutcome.OK, PipelineOutcome.NEEDS_REVIEW}:
        raise ValueError("파이프라인 결과 상태가 올바르지 않습니다.")
    if len(result.students) != len(present_students) or not present_students:
        raise ValueError("파이프라인 학생 결과 수가 명렬표와 다릅니다.")
    for index, student_result in enumerate(result.students):
        _validate_student_result(student_result, index)
    if result.outcome is PipelineOutcome.OK and any(
        item.assignment_status != "confirmed" for item in result.students
    ):
        raise ValueError("파이프라인 정상 결과에 검토 학생이 있습니다.")
    if result.outcome is PipelineOutcome.NEEDS_REVIEW and not any(
        item.assignment_status == "needs_review" for item in result.students
    ):
        raise ValueError("파이프라인 검토 결과에 검토 학생이 없습니다.")
    existing = session.scalar(
        select(func.count()).select_from(Submission).where(Submission.batch_id == batch.id)
    )
    if existing:
        raise ValueError("이미 저장된 배치 결과는 덮어쓸 수 없습니다.")

    root = _batches_directory()
    final = root / str(batch.id)
    if final.exists():
        raise RuntimeError("배치 결과 폴더가 이미 있습니다.")
    stage = root / f".batch-{batch.id}-{uuid.uuid4().hex}"
    os.mkdir(stage, 0o700)
    published = False
    try:
        for student_result, student in zip(result.students, present_students, strict=True):
            submission = Submission(
                batch_id=batch.id,
                student_id=student.id,
                page_start=student_result.page_range[0],
                page_end=student_result.page_range[1],
                assignment_status=student_result.assignment_status,
                recognized_name=student_result.recognized_name,
                assignment_note=student_result.assignment_note,
                anonymous_token=f"S-{secrets.token_hex(4)}",
            )
            session.add(submission)
            session.flush()
            directory = stage / str(submission.id)
            os.mkdir(directory, 0o700)
            final_directory = final / str(submission.id)
            for page_no, aligned in student_result.aligned_pages.items():
                aligned_name = f"page-{page_no}.png"
                ink_name = f"ink-{page_no}.png"
                _write_png(directory / aligned_name, aligned)
                _write_png(directory / ink_name, student_result.ink_pages[page_no])
                session.add(
                    PageImage(
                        submission_id=submission.id,
                        page_no=page_no,
                        aligned_path=str(final_directory / aligned_name),
                        ink_path=str(final_directory / ink_name),
                        registration_quality=student_result.registration_quality[page_no],
                    )
                )
            for item_no, crop in student_result.crops.items():
                crop_name = f"item-{item_no}.png"
                ink_crop_name = f"item-{item_no}-ink.png"
                _write_png(directory / crop_name, crop)
                _write_png(directory / ink_crop_name, student_result.ink_crops[item_no])
                session.add(
                    ItemResponse(
                        submission_id=submission.id,
                        item_no=item_no,
                        crop_path=str(final_directory / crop_name),
                        ink_crop_path=str(final_directory / ink_crop_name),
                    )
                )
        os.rename(stage, final)
        published = True
        batch.status = (
            "needs_review"
            if result.outcome is PipelineOutcome.NEEDS_REVIEW
            else "ready"
        )
        batch.failure_reason = None
        session.commit()
    except Exception:
        session.rollback()
        _remove_tree(final if published else stage, root)
        raise


def _process(payload: dict[str, Any], progress: ProgressFn) -> dict[str, Any]:
    with session_factory() as session:
        batch_id = payload.get("batch_id")
        if type(batch_id) is not int:
            raise ValueError("배치 번호가 올바르지 않습니다.")
        batch = session.get(ScanBatch, batch_id)
        if batch is None:
            raise ValueError("배치를 찾을 수 없습니다.")
        batch.status = "processing"
        batch.failure_reason = None
        session.commit()
        try:
            classroom = session.scalar(
                select(Classroom)
                .options(selectinload(Classroom.students))
                .where(Classroom.id == batch.classroom_id)
            )
            template = session.scalar(
                select(SheetTemplate)
                .options(selectinload(SheetTemplate.regions))
                .where(SheetTemplate.assessment_id == batch.assessment_id)
            )
            if classroom is None or template is None:
                raise ValueError
            present = classroom.present_students()
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
            return {"status": batch.status}
        except BaseException:
            session.rollback()
            failed = session.get(ScanBatch, batch_id)
            if failed is not None:
                failed.status = "failed"
                failed.failure_reason = _FAILED_REASON
                session.commit()
            raise RuntimeError(_FAILED_REASON) from None


def _batch_out(batch: ScanBatch, session: Session) -> BatchOut:
    submission_count = session.scalar(
        select(func.count()).select_from(Submission).where(Submission.batch_id == batch.id)
    ) or 0
    review_count = session.scalar(
        select(func.count()).select_from(Submission).where(
            Submission.batch_id == batch.id,
            Submission.assignment_status == "needs_review",
        )
    ) or 0
    return BatchOut(
        id=batch.id,
        status=batch.status,
        failure_reason=batch.failure_reason,
        submission_count=submission_count,
        review_count=review_count,
    )


@router.post("", response_model=BatchOut, status_code=status.HTTP_201_CREATED)
def upload_batch(
    assessment_id: int = Form(...),
    classroom_id: int = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> BatchOut:
    if assessment_id < 1 or classroom_id < 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "번호가 올바르지 않습니다.")
    load_assessment(assessment_id, session)
    classroom = session.scalar(
        select(Classroom)
        .options(selectinload(Classroom.students))
        .where(Classroom.id == classroom_id)
    )
    if classroom is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "학급을 찾을 수 없습니다.")
    present = classroom.present_students()
    if not present:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "응시 학생이 없습니다.")
    template = session.scalar(
        select(SheetTemplate)
        .options(selectinload(SheetTemplate.regions))
        .where(SheetTemplate.assessment_id == assessment_id)
    )
    if template is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "답안지 템플릿이 없습니다.")
    try:
        build_specs(template)
    except ValueError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "응답 영역과 식별정보 영역 지정을 먼저 마치세요.",
        ) from None

    stored, page_count = _store_scan_pdf(file)
    expected_pages = template.page_count * len(present)
    if page_count != expected_pages:
        _remove_file(stored)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "스캔 총 쪽수가 답안지 쪽 수와 응시 학생 수에 맞지 않습니다.",
        )
    batch = ScanBatch(
        assessment_id=assessment_id,
        classroom_id=classroom_id,
        stored_path=str(stored),
        status="pending",
    )
    session.add(batch)
    try:
        session.commit()
    except Exception:
        session.rollback()
        _remove_file(stored)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "스캔 배치를 저장하지 못했습니다.",
        ) from None

    scheduled = False
    try:
        job_id = get_runner().submit(
            "scan_batch",
            {"batch_id": batch.id},
            _process,
        )
        scheduled = True
        batch.job_id = job_id
        session.commit()
    except Exception:
        session.rollback()
        if not scheduled:
            stored_batch = session.get(ScanBatch, batch.id)
            if stored_batch is not None:
                session.delete(stored_batch)
                try:
                    session.commit()
                except SQLAlchemyError:
                    session.rollback()
                else:
                    _remove_file(stored)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "스캔 배치 작업을 시작하지 못했습니다.",
        ) from None
    return _batch_out(batch, session)


def _load_batch(batch_id: int, session: Session) -> ScanBatch:
    batch = session.get(ScanBatch, batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "배치를 찾을 수 없습니다.")
    return batch


@router.get("/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: int, session: Session = Depends(get_session)) -> BatchOut:
    return _batch_out(_load_batch(batch_id, session), session)


@router.get("/{batch_id}/submissions")
def list_submissions(
    batch_id: int,
    session: Session = Depends(get_session),
) -> dict[str, list[dict[str, Any]]]:
    _load_batch(batch_id, session)
    rows = session.execute(
        select(Submission, Student)
        .join(Student, Student.id == Submission.student_id)
        .where(Submission.batch_id == batch_id)
        .order_by(Submission.page_start)
    ).all()
    return {
        "submissions": [
            {
                "id": submission.id,
                "student_id": student.id,
                "student_name": student.name,
                "recognized_name": submission.recognized_name,
                "assignment_status": submission.assignment_status,
                "assignment_note": submission.assignment_note,
                "page_start": submission.page_start,
                "page_end": submission.page_end,
            }
            for submission, student in rows
        ]
    }


@router.post("/{batch_id}/submissions/{submission_id}/reassign")
def reassign_submission(
    batch_id: int,
    submission_id: int,
    payload: ReassignIn,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    batch = _load_batch(batch_id, session)
    submission = session.get(Submission, submission_id)
    if submission is None or submission.batch_id != batch_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "제출물을 찾을 수 없습니다.")
    student = session.get(Student, payload.student_id)
    if student is None or student.classroom_id != batch.classroom_id or student.absent:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "이 배치 학급의 응시 학생만 배정할 수 있습니다.",
        )
    duplicate = session.scalar(
        select(Submission.id).where(
            Submission.batch_id == batch_id,
            Submission.student_id == student.id,
            Submission.id != submission.id,
        )
    )
    if duplicate is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "이미 다른 제출물에 배정된 학생입니다.",
        )
    submission.student_id = student.id
    submission.assignment_status = "confirmed"
    submission.assignment_note = "교사가 직접 배정함"
    remaining = session.scalar(
        select(func.count()).select_from(Submission).where(
            Submission.batch_id == batch_id,
            Submission.assignment_status == "needs_review",
        )
    ) or 0
    batch.status = "needs_review" if remaining else "ready"
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "학생 배정이 중복되었습니다.",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "학생 배정 상태를 저장하지 못했습니다.",
        ) from None
    return {
        "id": submission.id,
        "student_id": submission.student_id,
        "assignment_status": submission.assignment_status,
    }
