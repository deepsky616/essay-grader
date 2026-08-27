"""정합된 페이지에서 식별정보와 겹치지 않는 응답 영역만 잘라낸다."""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

import numpy as np


Rect = tuple[int, int, int, int]
MAX_IMAGE_VALUES = 100_000_000
MAX_REGIONS = 500


class PIIBoundaryViolation(Exception):
    """응답 영역이 식별정보 영역과 겹쳐 크롭을 만들 수 없을 때 발생한다."""


@dataclass(frozen=True)
class CropSpec:
    item_no: int
    x: int
    y: int
    width: int
    height: int

    def __post_init__(self) -> None:
        if type(self.item_no) is not int or self.item_no < 1:
            raise ValueError("응답 영역의 문항 번호가 올바르지 않습니다.")
        if any(type(value) is not int for value in (self.x, self.y, self.width, self.height)):
            raise ValueError("응답 영역 좌표는 정수여야 합니다.")
        if self.width <= 0 or self.height <= 0:
            raise ValueError("응답 영역 크기는 양수여야 합니다.")

    def as_rect(self) -> Rect:
        return (self.x, self.y, self.width, self.height)


def _page_shape(page: np.ndarray) -> tuple[int, int]:
    if (
        not isinstance(page, np.ndarray)
        or page.dtype != np.uint8
        or page.size == 0
        or page.size > MAX_IMAGE_VALUES
    ):
        raise ValueError("페이지는 크기가 제한된 8비트 이미지여야 합니다.")
    if page.ndim == 2:
        pass
    elif page.ndim == 3 and page.shape[2] in (3, 4):
        pass
    else:
        raise ValueError("페이지 이미지 채널 수가 올바르지 않습니다.")
    height, width = page.shape[:2]
    return int(height), int(width)


def _intersects(left: Rect, right: Rect) -> bool:
    left_x, left_y, left_width, left_height = left
    right_x, right_y, right_width, right_height = right
    return (
        left_x < right_x + right_width
        and right_x < left_x + left_width
        and left_y < right_y + right_height
        and right_y < left_y + left_height
    )


def _checked_pii_rects(
    pii_rects: list[Rect] | None,
    page_width: int,
    page_height: int,
) -> tuple[Rect, ...]:
    if pii_rects is None:
        return ()
    if type(pii_rects) is not list or len(pii_rects) > MAX_REGIONS:
        raise ValueError("식별정보 영역 목록이 올바르지 않습니다.")

    checked: list[Rect] = []
    for rect in pii_rects:
        if (
            type(rect) is not tuple
            or len(rect) != 4
            or any(type(value) is not int for value in rect)
        ):
            raise ValueError("식별정보 영역 좌표가 올바르지 않습니다.")
        x, y, width, height = rect
        if (
            x < 0
            or y < 0
            or width <= 0
            or height <= 0
            or x + width > page_width
            or y + height > page_height
        ):
            raise ValueError("식별정보 영역이 페이지 범위를 벗어났습니다.")
        checked.append(rect)
    return tuple(checked)


def _crop_checked(
    page: np.ndarray,
    spec: CropSpec,
    pii_rects: tuple[Rect, ...],
    page_width: int,
    page_height: int,
) -> np.ndarray:
    if any(_intersects(spec.as_rect(), pii) for pii in pii_rects):
        raise PIIBoundaryViolation(
            f"{spec.item_no}번 응답 영역이 식별정보 영역과 겹칩니다. "
            "영역 지정 화면에서 겹치지 않게 조정하세요."
        )

    x0 = max(0, spec.x)
    y0 = max(0, spec.y)
    x1 = min(page_width, spec.x + spec.width)
    y1 = min(page_height, spec.y + spec.height)
    if x0 >= x1 or y0 >= y1:
        raise ValueError(
            f"{spec.item_no}번 응답 영역이 페이지 밖에 있습니다."
        )

    result = np.ascontiguousarray(page[y0:y1, x0:x1].copy())
    result.setflags(write=False)
    return result


def crop_region(
    page: np.ndarray,
    spec: CropSpec,
    pii_rects: list[Rect] | None = None,
) -> np.ndarray:
    if type(spec) is not CropSpec:
        raise ValueError("응답 영역 정보가 올바르지 않습니다.")
    page_height, page_width = _page_shape(page)
    checked_pii = _checked_pii_rects(pii_rects, page_width, page_height)
    return _crop_checked(
        page,
        spec,
        checked_pii,
        page_width,
        page_height,
    )


def crop_regions(
    page: np.ndarray,
    specs: list[CropSpec],
    pii_rects: list[Rect] | None = None,
) -> Mapping[int, np.ndarray]:
    page_height, page_width = _page_shape(page)
    checked_pii = _checked_pii_rects(pii_rects, page_width, page_height)
    if type(specs) is not list or len(specs) > MAX_REGIONS:
        raise ValueError("응답 영역 목록이 올바르지 않습니다.")
    if any(type(spec) is not CropSpec for spec in specs):
        raise ValueError("응답 영역 정보가 올바르지 않습니다.")
    item_numbers = [spec.item_no for spec in specs]
    if len(set(item_numbers)) != len(item_numbers):
        raise ValueError("응답 영역의 문항 번호가 중복되었습니다.")

    result = {
        spec.item_no: _crop_checked(
            page,
            spec,
            checked_pii,
            page_width,
            page_height,
        )
        for spec in specs
    }
    return MappingProxyType(result)
