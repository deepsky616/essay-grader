"""원본 답안지에 마커와 응답 박스를 더해 배부용 PDF를 만든다.

설계 문서 7.1절, 7.2절, 14절의 인쇄 계약을 한곳에서 강제한다. 네 모서리
마커는 쪽 번호와 정합점을 함께 제공하고, 응답 박스는 뒤 크롭의 경계를
분명하게 한다.
"""

from collections.abc import Mapping
from functools import lru_cache
import io
import math
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

import fitz
from PIL import Image

from app.services.markers import CORNERS, MAX_PAGES, encode_marker_id, render_marker


MARKER_SIZE_PT = 24.0
MARKER_MARGIN_PT = 18.0
QUIET_ZONE_PT = 6.0
MARKER_RENDER_PX = 200
MAX_REGIONS = 500

_REGION_FIELDS = ("page_no", "x", "y", "width", "height")


def _marker_rects(page_width: float, page_height: float) -> tuple[fitz.Rect, ...]:
    size = MARKER_SIZE_PT
    margin = MARKER_MARGIN_PT
    right = page_width - margin - size
    bottom = page_height - margin - size
    origins = (
        (margin, margin),
        (right, margin),
        (right, bottom),
        (margin, bottom),
    )
    return tuple(fitz.Rect(x, y, x + size, y + size) for x, y in origins)


def _quiet_rect(rect: fitz.Rect) -> fitz.Rect:
    return fitz.Rect(
        rect.x0 - QUIET_ZONE_PT,
        rect.y0 - QUIET_ZONE_PT,
        rect.x1 + QUIET_ZONE_PT,
        rect.y1 + QUIET_ZONE_PT,
    )


@lru_cache(maxsize=MAX_PAGES * CORNERS)
def _marker_png(marker_id: int) -> bytes:
    array = render_marker(marker_id, size_px=MARKER_RENDER_PX)
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="PNG")
    return buffer.getvalue()


def _paths(source_pdf: Path, output_pdf: Path) -> tuple[Path, Path]:
    try:
        source = Path(source_pdf)
        output = Path(output_pdf)
    except TypeError as exc:
        raise ValueError("답안지 파일 경로가 올바르지 않습니다.") from exc

    if not source.is_file():
        raise ValueError("원본 답안지 PDF를 찾을 수 없습니다.")
    if source.resolve() == output.resolve():
        raise ValueError("출력 PDF는 원본 답안지와 다른 파일이어야 합니다.")
    if not output.parent.is_dir():
        raise ValueError("출력 PDF를 저장할 폴더를 찾을 수 없습니다.")
    if output.exists() and not output.is_file():
        raise ValueError("출력 PDF 경로가 파일이 아닙니다.")
    return source, output


def _number(value: Any) -> float:
    if type(value) not in (int, float):
        raise ValueError("응답 영역 좌표가 올바르지 않습니다.")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("응답 영역 좌표가 올바르지 않습니다.")
    return number


def _intersects(left: fitz.Rect, right: fitz.Rect) -> bool:
    return (
        left.x0 < right.x1
        and right.x0 < left.x1
        and left.y0 < right.y1
        and right.y0 < left.y1
    )


def _checked_regions(
    regions: list[dict[str, Any]],
    pages: tuple[tuple[float, float], ...],
) -> tuple[tuple[int, fitz.Rect], ...]:
    if type(regions) is not list or len(regions) > MAX_REGIONS:
        raise ValueError("응답 영역 목록이 올바르지 않습니다.")

    checked: list[tuple[int, fitz.Rect]] = []
    for raw in regions:
        if not isinstance(raw, Mapping) or any(field not in raw for field in _REGION_FIELDS):
            raise ValueError("응답 영역 정보가 올바르지 않습니다.")

        page_no = raw["page_no"]
        if type(page_no) is not int or not 1 <= page_no <= len(pages):
            raise ValueError("응답 영역의 쪽 번호가 올바르지 않습니다.")

        x = _number(raw["x"])
        y = _number(raw["y"])
        width = _number(raw["width"])
        height = _number(raw["height"])
        page_width, page_height = pages[page_no - 1]
        if (
            x < 0
            or y < 0
            or width <= 0
            or height <= 0
            or x + width > page_width
            or y + height > page_height
        ):
            raise ValueError("응답 영역이 답안지 범위를 벗어났습니다.")

        rect = fitz.Rect(x, y, x + width, y + height)
        marker_zones = (
            _quiet_rect(marker_rect)
            for marker_rect in _marker_rects(page_width, page_height)
        )
        if any(_intersects(rect, zone) for zone in marker_zones):
            raise ValueError("응답 영역이 쪽 마커와 겹칩니다.")
        checked.append((page_no, rect))
    return tuple(checked)


def _page_sizes(document: fitz.Document) -> tuple[tuple[float, float], ...]:
    if document.page_count < 1:
        raise ValueError("답안지 PDF에 쪽이 없습니다.")
    if document.page_count > MAX_PAGES:
        raise ValueError(
            f"쪽 번호 마커는 {MAX_PAGES}쪽까지만 지원합니다."
        )

    minimum = 2 * (MARKER_MARGIN_PT + MARKER_SIZE_PT + QUIET_ZONE_PT)
    sizes: list[tuple[float, float]] = []
    for page in document:
        width = float(page.rect.width)
        height = float(page.rect.height)
        if not math.isfinite(width) or not math.isfinite(height) or min(width, height) < minimum:
            raise ValueError("답안지 크기가 마커를 넣기에 너무 작습니다.")
        sizes.append((width, height))
    return tuple(sizes)


def build_printable_sheet(
    source_pdf: Path,
    output_pdf: Path,
    regions: list[dict[str, Any]],
) -> Path:
    """검사된 원본과 영역으로 배부용 PDF를 원자적으로 만든다."""
    source, output = _paths(source_pdf, output_pdf)
    temporary = output.with_name(f".{output.name}.{uuid4().hex}.tmp")

    try:
        try:
            document = fitz.open(source)
        except Exception as exc:
            raise ValueError("원본 답안지 PDF를 열 수 없습니다.") from exc

        with document:
            if document.needs_pass:
                raise ValueError("암호로 잠긴 답안지 PDF는 사용할 수 없습니다.")
            sizes = _page_sizes(document)
            checked_regions = _checked_regions(regions, sizes)

            for index, page in enumerate(document):
                page_no = index + 1
                width, height = sizes[index]
                for corner, rect in enumerate(_marker_rects(width, height)):
                    page.draw_rect(
                        _quiet_rect(rect),
                        color=None,
                        fill=(1, 1, 1),
                        overlay=True,
                    )
                    page.insert_image(
                        rect,
                        stream=_marker_png(encode_marker_id(page_no, corner)),
                        overlay=True,
                    )

                for region_page, rect in checked_regions:
                    if region_page == page_no:
                        page.draw_rect(
                            rect,
                            color=(0.6, 0.6, 0.6),
                            width=0.7,
                            overlay=True,
                        )

            document.save(temporary, garbage=4, deflate=True)

        with fitz.open(temporary) as completed:
            if completed.page_count != len(sizes):
                raise ValueError("배부용 답안지 PDF 검증에 실패했습니다.")
        os.replace(temporary, output)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("배부용 답안지 PDF를 저장할 수 없습니다.") from exc
    finally:
        temporary.unlink(missing_ok=True)

    return output
