import cv2
import numpy as np
import pytest

from app.services.markers import (
    CORNERS,
    MAX_PAGES,
    DetectedPage,
    MarkerDetectionError,
    decode_marker_id,
    detect_page_markers,
    encode_marker_id,
    render_marker,
)


def test_marker_id_round_trips():
    for page_no in (1, 2, 17, MAX_PAGES):
        for corner in range(CORNERS):
            marker_id = encode_marker_id(page_no, corner)
            assert decode_marker_id(marker_id) == (page_no, corner)


def test_marker_ids_are_unique_across_full_capacity():
    ids = {
        encode_marker_id(page, corner)
        for page in range(1, MAX_PAGES + 1)
        for corner in range(CORNERS)
    }
    assert len(ids) == MAX_PAGES * CORNERS
    assert min(ids) == 0
    assert max(ids) == 247


@pytest.mark.parametrize(
    ("page_no", "corner"),
    [(0, 0), (MAX_PAGES + 1, 0), (1, -1), (1, CORNERS), (True, 0)],
)
def test_invalid_page_or_corner_is_rejected_without_value_echo(page_no, corner):
    with pytest.raises(ValueError) as caught:
        encode_marker_id(page_no, corner)
    assert str(page_no) not in str(caught.value) or page_no is True


@pytest.mark.parametrize("marker_id", [-1, 248, 249, True, "1"])
def test_decode_rejects_reserved_or_non_integer_ids(marker_id):
    with pytest.raises(ValueError):
        decode_marker_id(marker_id)


def test_render_marker_produces_square_binary_image():
    image = render_marker(encode_marker_id(1, 0), size_px=80)

    assert image.shape == (80, 80)
    assert image.dtype == np.uint8
    assert set(np.unique(image)).issubset({0, 255})


@pytest.mark.parametrize("size_px", [0, 7, True, 10.5])
def test_render_marker_rejects_unsafe_size(size_px):
    with pytest.raises(ValueError):
        render_marker(0, size_px)


def _synthetic_page(
    page_no: int,
    width: int = 1000,
    height: int = 1400,
    margin: int = 60,
    marker: int = 90,
) -> np.ndarray:
    page = np.full((height, width), 255, dtype=np.uint8)
    positions = [
        (margin, margin),
        (width - margin - marker, margin),
        (width - margin - marker, height - margin - marker),
        (margin, height - margin - marker),
    ]
    for corner, (x, y) in enumerate(positions):
        image = render_marker(encode_marker_id(page_no, corner), marker)
        page[y : y + marker, x : x + marker] = image
    return page


def test_detects_all_four_markers_and_page_number():
    result = detect_page_markers(_synthetic_page(page_no=3))

    assert result is not None
    assert result.page_no == 3
    assert len(result.corner_points) == 4
    assert result.is_complete
    assert result.missing_corners() == []


def test_detected_result_cannot_be_mutated():
    result = detect_page_markers(_synthetic_page(page_no=1))
    assert isinstance(result, DetectedPage)

    with pytest.raises(TypeError):
        result.corner_points[0] = (0.0, 0.0)


def test_returns_none_when_no_markers_present():
    blank = np.full((600, 400), 255, dtype=np.uint8)
    assert detect_page_markers(blank) is None


def test_detects_after_rotation_and_scaling():
    page = _synthetic_page(page_no=2)
    center = (page.shape[1] / 2, page.shape[0] / 2)
    matrix = cv2.getRotationMatrix2D(center, angle=4.0, scale=0.92)
    warped = cv2.warpAffine(
        page,
        matrix,
        (page.shape[1], page.shape[0]),
        borderValue=255,
    )

    result = detect_page_markers(warped)

    assert result is not None
    assert result.page_no == 2
    assert result.is_complete


def test_color_image_is_supported():
    color = cv2.cvtColor(_synthetic_page(4), cv2.COLOR_GRAY2BGR)
    assert detect_page_markers(color).page_no == 4


def test_partial_detection_reports_missing_corners():
    page = _synthetic_page(page_no=1)
    page[:200, :] = 255

    result = detect_page_markers(page)

    assert result is not None
    assert result.page_no == 1
    assert len(result.corner_points) == 2
    assert not result.is_complete
    assert result.missing_corners() == ["좌상", "우상"]


def test_mixed_page_markers_are_rejected_instead_of_majority_selection():
    page = _synthetic_page(page_no=1)
    marker = 90
    replacement = render_marker(encode_marker_id(2, 3), marker)
    page[-150:-60, 60:150] = replacement

    with pytest.raises(MarkerDetectionError, match="여러 쪽"):
        detect_page_markers(page)


def test_duplicate_corner_marker_is_rejected():
    page = _synthetic_page(page_no=1)
    duplicate = render_marker(encode_marker_id(1, 0), 90)
    page[300:390, 300:390] = duplicate

    with pytest.raises(MarkerDetectionError, match="중복"):
        detect_page_markers(page)


def test_reserved_dictionary_id_is_rejected_when_scanned():
    page = np.full((500, 500), 255, dtype=np.uint8)
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_250)
    page[100:220, 100:220] = cv2.aruco.generateImageMarker(
        dictionary, 249, 120
    )

    with pytest.raises(MarkerDetectionError, match="예약되지 않은"):
        detect_page_markers(page)


@pytest.mark.parametrize(
    "image",
    [
        np.array([], dtype=np.uint8),
        np.zeros((20, 20), dtype=np.float32),
        np.zeros((20, 20, 2), dtype=np.uint8),
        "not-an-image",
    ],
)
def test_invalid_image_is_rejected(image):
    with pytest.raises(ValueError):
        detect_page_markers(image)
