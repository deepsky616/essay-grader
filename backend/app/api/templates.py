import os
from pathlib import Path as FilePath
import stat
from typing import Annotated, Literal
import uuid

import fitz
from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.assessments import load_assessment
from app.config import settings
from app.db import get_session
from app.models.document import SourceDocument
from app.models.sheet_template import RegionSpec, SheetTemplate
from app.services.sheet_builder import build_printable_sheet


router = APIRouter(
    prefix="/api/assessments/{assessment_id}/template",
    tags=["template"],
)

TEMPLATE_DPI = 200
MAX_TEMPLATE_PAGES = 62
MAX_TEMPLATE_REGIONS = 500
MAX_RENDER_PIXELS = 40_000_000
MAX_STORED_FILE_BYTES = 50 * 1024 * 1024

_SOURCE_ERROR = "원본 답안지 PDF를 안전하게 사용할 수 없습니다."
_PRINTABLE_ERROR = "배부용 답안지 PDF를 만들 수 없습니다. 원본과 영역을 확인하세요."


PositiveInt = Annotated[StrictInt, Field(ge=1)]
NonNegativeInt = Annotated[StrictInt, Field(ge=0)]


class RegionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    region_type: Literal["response", "pii"]
    item_no: PositiveInt | None
    page_no: PositiveInt
    x: NonNegativeInt
    y: NonNegativeInt
    width: PositiveInt
    height: PositiveInt

    @model_validator(mode="after")
    def item_matches_type(self) -> "RegionIn":
        if self.region_type == "response" and self.item_no is None:
            raise ValueError("응답 영역에는 문항 번호가 필요합니다.")
        if self.region_type == "pii" and self.item_no is not None:
            raise ValueError("식별정보 영역에는 문항 번호를 넣을 수 없습니다.")
        return self


class RegionsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    regions: Annotated[list[RegionIn], Field(max_length=MAX_TEMPLATE_REGIONS)]


class TemplateOut(BaseModel):
    id: int
    page_count: int
    dpi: int
    printable_ready: bool


def _template_out(template: SheetTemplate) -> TemplateOut:
    return TemplateOut(
        id=template.id,
        page_count=template.page_count,
        dpi=TEMPLATE_DPI,
        printable_ready=template.printable_path is not None,
    )


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


def _safe_stored_file(raw_path: str | None) -> FilePath | None:
    if not raw_path:
        return None
    uploads = settings.uploads_dir()
    try:
        uploads_metadata = os.lstat(uploads)
        path = FilePath(raw_path)
        metadata = os.lstat(path)
        uploads_resolved = uploads.resolve(strict=True)
        parent_resolved = path.parent.resolve(strict=True)
    except (OSError, ValueError):
        return None
    if (
        not stat.S_ISDIR(uploads_metadata.st_mode)
        or stat.S_ISLNK(uploads_metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or parent_resolved != uploads_resolved
        or metadata.st_size < 1
        or metadata.st_size > MAX_STORED_FILE_BYTES
    ):
        return None
    return path


def _source_document(
    template: SheetTemplate,
    session: Session,
) -> tuple[SourceDocument, FilePath]:
    document = session.get(SourceDocument, template.source_document_id)
    path = _safe_stored_file(document.stored_path if document is not None else None)
    if document is None or document.kind != "answer_sheet" or path is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _SOURCE_ERROR)
    return document, path


def _inspect_source(path: FilePath) -> tuple[int, tuple[tuple[int, int], ...]]:
    try:
        with fitz.open(path) as document:
            if document.needs_pass or not document.is_pdf:
                raise ValueError
            if not 1 <= document.page_count <= MAX_TEMPLATE_PAGES:
                raise ValueError
            scale = TEMPLATE_DPI / 72.0
            sizes: list[tuple[int, int]] = []
            for page in document:
                pixel_rect = (page.rect * fitz.Matrix(scale, scale)).irect
                width = int(pixel_rect.width)
                height = int(pixel_rect.height)
                if (
                    width < 1
                    or height < 1
                    or width * height > MAX_RENDER_PIXELS
                ):
                    raise ValueError
                sizes.append((width, height))
            return document.page_count, tuple(sizes)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _SOURCE_ERROR) from None


def _commit_or_conflict(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "답안지 템플릿 자료의 무결성 제약을 확인하세요.",
        ) from None
    except SQLAlchemyError:
        session.rollback()
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "답안지 템플릿 정보를 저장하지 못했습니다.",
        ) from None


def _intersects(left: RegionIn, right: RegionIn) -> bool:
    return (
        left.page_no == right.page_no
        and left.x < right.x + right.width
        and right.x < left.x + left.width
        and left.y < right.y + right.height
        and right.y < left.y + left.height
    )


def _checked_regions(
    regions: list[RegionIn],
    page_sizes: tuple[tuple[int, int], ...],
) -> None:
    responses = [region for region in regions if region.region_type == "response"]
    pii_regions = [region for region in regions if region.region_type == "pii"]
    item_numbers = [region.item_no for region in responses]
    if len(set(item_numbers)) != len(item_numbers):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "응답 영역의 문항 번호가 중복되었습니다.",
        )
    if len(pii_regions) > 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "식별정보 영역은 하나만 지정할 수 있습니다.",
        )

    for region in regions:
        if region.page_no > len(page_sizes):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "영역의 쪽 번호가 답안지 범위를 벗어났습니다.",
            )
        page_width, page_height = page_sizes[region.page_no - 1]
        if region.x + region.width > page_width or region.y + region.height > page_height:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "영역이 답안지 페이지 범위를 벗어났습니다.",
            )
    for response_region in responses:
        if any(_intersects(response_region, pii_region) for pii_region in pii_regions):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "응답 영역과 식별정보 영역이 겹칩니다.",
            )


@router.post("", response_model=TemplateOut)
def create_template(
    assessment_id: Annotated[int, Path(ge=1)],
    session: Session = Depends(get_session),
) -> TemplateOut:
    load_assessment(assessment_id, session)
    document = session.scalar(
        select(SourceDocument)
        .where(
            SourceDocument.assessment_id == assessment_id,
            SourceDocument.kind == "answer_sheet",
        )
        .order_by(SourceDocument.id.desc())
    )
    if document is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "빈 답안지 PDF를 먼저 업로드하세요.",
        )
    path = _safe_stored_file(document.stored_path)
    if path is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _SOURCE_ERROR)
    page_count, _sizes = _inspect_source(path)
    if page_count != document.page_count:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _SOURCE_ERROR)

    template = session.scalar(
        select(SheetTemplate).where(SheetTemplate.assessment_id == assessment_id)
    )
    if template is None:
        template = SheetTemplate(
            assessment_id=assessment_id,
            source_document_id=document.id,
            page_count=page_count,
        )
        session.add(template)
    elif template.source_document_id != document.id:
        template.regions.clear()
        template.source_document_id = document.id
        template.page_count = page_count
        template.printable_path = None
    else:
        template.page_count = page_count
    _commit_or_conflict(session)
    return _template_out(template)


@router.get("/pages/{page_no}")
def get_template_page(
    assessment_id: Annotated[int, Path(ge=1)],
    page_no: Annotated[int, Path(ge=1)],
    session: Session = Depends(get_session),
) -> Response:
    template = _load_template(assessment_id, session)
    _document_record, source = _source_document(template, session)
    page_count, _sizes = _inspect_source(source)
    if page_no > page_count:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "그런 쪽이 없습니다.")
    try:
        with fitz.open(source) as document:
            pixmap = document[page_no - 1].get_pixmap(
                dpi=TEMPLATE_DPI,
                alpha=False,
            )
            png = pixmap.tobytes("png")
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _SOURCE_ERROR) from None
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/regions")
def save_regions(
    assessment_id: Annotated[int, Path(ge=1)],
    payload: RegionsIn,
    session: Session = Depends(get_session),
) -> dict[str, int]:
    template = _load_template(assessment_id, session)
    _document, source = _source_document(template, session)
    page_count, page_sizes = _inspect_source(source)
    if page_count != template.page_count:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _SOURCE_ERROR)
    _checked_regions(payload.regions, page_sizes)

    template.regions.clear()
    session.flush()
    for region in payload.regions:
        template.regions.append(
            RegionSpec(
                **region.model_dump(),
            )
        )
    template.printable_path = None
    _commit_or_conflict(session)
    return {"saved": len(payload.regions)}


@router.get("/regions")
def get_regions(
    assessment_id: Annotated[int, Path(ge=1)],
    session: Session = Depends(get_session),
) -> dict[str, list[dict[str, object]]]:
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


def _remove_generated(path: FilePath) -> None:
    safe = _safe_stored_file(str(path))
    if safe != path:
        return
    try:
        path.unlink()
    except OSError:
        pass


@router.post("/printable")
def generate_printable(
    assessment_id: Annotated[int, Path(ge=1)],
    session: Session = Depends(get_session),
) -> dict[str, str]:
    template = _load_template(assessment_id, session)
    _document, source = _source_document(template, session)
    response_regions = [
        region for region in template.regions if region.region_type == "response"
    ]
    pii_regions = [
        region for region in template.regions if region.region_type == "pii"
    ]
    if not response_regions:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "응답 영역을 하나 이상 지정하세요.",
        )
    if len(pii_regions) != 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "식별정보 영역을 하나 지정하세요.",
        )

    scale = 72.0 / TEMPLATE_DPI
    regions = [
        {
            "page_no": region.page_no,
            "x": region.x * scale,
            "y": region.y * scale,
            "width": region.width * scale,
            "height": region.height * scale,
        }
        for region in response_regions
    ]
    output = settings.uploads_dir() / f"printable-{uuid.uuid4().hex}.pdf"
    try:
        build_printable_sheet(source, output, regions)
        os.chmod(output, 0o600)
    except Exception:
        _remove_generated(output)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _PRINTABLE_ERROR) from None

    template.printable_path = str(output)
    try:
        _commit_or_conflict(session)
    except HTTPException:
        _remove_generated(output)
        raise
    return {"status": "ok"}


@router.get("/printable")
def download_printable(
    assessment_id: Annotated[int, Path(ge=1)],
    session: Session = Depends(get_session),
) -> Response:
    template = _load_template(assessment_id, session)
    path = _safe_stored_file(template.printable_path)
    if path is None or not path.name.startswith("printable-"):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "먼저 배부용 답안지를 생성하세요.",
        )
    try:
        content = path.read_bytes()
    except OSError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "먼저 배부용 답안지를 생성하세요.",
        ) from None
    if not content.startswith(b"%PDF"):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "먼저 배부용 답안지를 생성하세요.",
        )
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename=printable-answer-sheet.pdf",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
