from types import MappingProxyType

import numpy as np
import pytest

from app.services.cropper import (
    CropSpec,
    PIIBoundaryViolation,
    crop_region,
    crop_regions,
)


def _page() -> np.ndarray:
    page = np.zeros((500, 400), dtype=np.uint8)
    page[100:200, 50:150] = 255
    return page


def test_crop_returns_requested_area_as_read_only_copy() -> None:
    page = _page()
    crop = crop_region(
        page,
        CropSpec(item_no=1, x=50, y=100, width=100, height=100),
    )

    assert crop.shape == (100, 100)
    assert np.all(crop == 255)
    assert not crop.flags.writeable
    assert not np.shares_memory(crop, page)


def test_crop_is_clipped_to_page_bounds() -> None:
    crop = crop_region(
        _page(),
        CropSpec(item_no=1, x=350, y=450, width=200, height=200),
    )

    assert crop.shape == (50, 50)


def test_negative_origin_is_clipped() -> None:
    crop = crop_region(
        _page(),
        CropSpec(item_no=1, x=-20, y=-10, width=50, height=40),
    )

    assert crop.shape == (30, 30)


def test_fully_outside_crop_raises() -> None:
    with pytest.raises(ValueError, match="응답 영역"):
        crop_region(
            _page(),
            CropSpec(item_no=1, x=500, y=600, width=50, height=50),
        )


def test_crop_overlapping_pii_region_is_blocked() -> None:
    spec = CropSpec(item_no=1, x=40, y=40, width=120, height=120)

    with pytest.raises(PIIBoundaryViolation, match="식별정보"):
        crop_region(_page(), spec, pii_rects=[(100, 100, 100, 100)])


def test_crop_touching_pii_edge_is_allowed() -> None:
    spec = CropSpec(item_no=1, x=200, y=300, width=100, height=100)
    crop = crop_region(_page(), spec, pii_rects=[(100, 300, 100, 100)])

    assert crop.shape == (100, 100)


def test_crop_regions_returns_immutable_map_keyed_by_item() -> None:
    specs = [
        CropSpec(item_no=1, x=0, y=0, width=100, height=100),
        CropSpec(item_no=2, x=100, y=100, width=100, height=100),
    ]
    crops = crop_regions(_page(), specs)

    assert isinstance(crops, MappingProxyType)
    assert set(crops) == {1, 2}
    assert crops[1].shape == (100, 100)


def test_duplicate_item_numbers_are_rejected() -> None:
    specs = [
        CropSpec(item_no=1, x=0, y=0, width=100, height=100),
        CropSpec(item_no=1, x=100, y=100, width=100, height=100),
    ]

    with pytest.raises(ValueError, match="문항 번호"):
        crop_regions(_page(), specs)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"item_no": True, "x": 0, "y": 0, "width": 1, "height": 1},
        {"item_no": 0, "x": 0, "y": 0, "width": 1, "height": 1},
        {"item_no": 1, "x": 0.0, "y": 0, "width": 1, "height": 1},
        {"item_no": 1, "x": 0, "y": 0, "width": 0, "height": 1},
        {"item_no": 1, "x": 0, "y": 0, "width": 1, "height": -1},
    ],
)
def test_crop_spec_rejects_invalid_fields(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError, match="영역"):
        CropSpec(**kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "page",
    [
        np.zeros((0, 2), dtype=np.uint8),
        np.zeros((10, 10), dtype=np.float32),
        np.zeros((10, 10, 2), dtype=np.uint8),
        np.zeros((10,), dtype=np.uint8),
    ],
)
def test_rejects_invalid_page(page: np.ndarray) -> None:
    with pytest.raises(ValueError, match="페이지"):
        crop_region(page, CropSpec(item_no=1, x=0, y=0, width=1, height=1))


@pytest.mark.parametrize(
    "pii_rects",
    [
        [(0, 0, 0, 10)],
        [(-1, 0, 10, 10)],
        [(390, 0, 20, 10)],
        [(0.0, 0, 10, 10)],
        [(0, 0, 10)],
    ],
)
def test_rejects_invalid_pii_rects(pii_rects: object) -> None:
    with pytest.raises(ValueError, match="식별정보"):
        crop_region(
            _page(),
            CropSpec(item_no=1, x=200, y=200, width=10, height=10),
            pii_rects=pii_rects,  # type: ignore[arg-type]
        )


def test_accepts_color_page() -> None:
    page = np.zeros((50, 50, 3), dtype=np.uint8)

    crop = crop_region(page, CropSpec(item_no=1, x=5, y=5, width=10, height=10))

    assert crop.shape == (10, 10, 3)
