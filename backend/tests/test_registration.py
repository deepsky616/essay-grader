import cv2
import numpy as np
import pytest

from app.services.markers import CORNERS, encode_marker_id, render_marker
from app.services.registration import RegistrationFailed, register_page


def _template(
    page_no: int = 1,
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
        page[y : y + marker, x : x + marker] = render_marker(
            encode_marker_id(page_no, corner),
            size_px=marker,
        )
    cv2.rectangle(page, (400, 600), (600, 700), 0, 3)
    cv2.putText(page, "123", (420, 680), cv2.FONT_HERSHEY_SIMPLEX, 1.3, 0, 3)
    return page


def _markerless_template(width: int = 900, height: int = 1200) -> np.ndarray:
    image = np.full((height, width), 255, dtype=np.uint8)
    random = np.random.default_rng(20260816)
    for _ in range(180):
        x = int(random.integers(40, width - 40))
        y = int(random.integers(40, height - 40))
        radius = int(random.integers(2, 8))
        cv2.circle(image, (x, y), radius, 0, -1)
    for index in range(12):
        cv2.putText(
            image,
            f"item-{index}",
            (80, 100 + index * 80),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            0,
            2,
        )
    return image


def test_identity_registration_returns_same_image() -> None:
    template = _template()
    result = register_page(template, template)

    assert result.page_no == 1
    assert result.method == "markers"
    assert result.quality > 0.9
    assert np.mean(np.abs(result.aligned.astype(int) - template.astype(int))) < 5


def test_recovers_rotated_and_shifted_scan() -> None:
    template = _template()
    matrix = cv2.getRotationMatrix2D((500.0, 700.0), angle=3.5, scale=0.94)
    matrix[0, 2] += 25
    matrix[1, 2] -= 12
    scan = cv2.warpAffine(template, matrix, (1000, 1400), borderValue=255)

    result = register_page(scan, template)

    assert result.page_no == 1
    difference = np.mean(np.abs(result.aligned.astype(int) - template.astype(int)))
    assert difference < 20


def test_raises_when_markers_missing_from_marked_template() -> None:
    template = _template()
    blank = np.full((1400, 1000), 255, dtype=np.uint8)

    with pytest.raises(RegistrationFailed, match="마커"):
        register_page(blank, template)


def test_raises_when_too_few_corners() -> None:
    template = _template()
    scan = _template()
    scan[:250, :] = 255

    with pytest.raises(RegistrationFailed, match="모서리"):
        register_page(scan, template)


def test_aligned_output_matches_template_shape() -> None:
    template = _template()
    scan = cv2.resize(_template(), (700, 980))
    result = register_page(scan, template)

    assert result.aligned.shape == template.shape
    assert not result.aligned.flags.writeable


def test_rejects_different_page_numbers() -> None:
    with pytest.raises(RegistrationFailed, match="쪽 번호"):
        register_page(_template(page_no=2), _template(page_no=1))


def test_markerless_template_uses_feature_fallback() -> None:
    template = _markerless_template()
    source = np.float32([[0, 0], [899, 0], [899, 1199], [0, 1199]])
    destination = np.float32([[24, 18], [870, 35], [888, 1170], [12, 1184]])
    transform = cv2.getPerspectiveTransform(source, destination)
    scan = cv2.warpPerspective(template, transform, (900, 1200), borderValue=255)

    result = register_page(scan, template)

    assert result.page_no is None
    assert result.method == "features"
    assert result.quality >= 0.3
    assert np.mean(np.abs(result.aligned.astype(int) - template.astype(int))) < 18


def test_feature_fallback_rejects_low_information_images() -> None:
    blank = np.full((800, 600), 255, dtype=np.uint8)

    with pytest.raises(RegistrationFailed, match="특징점"):
        register_page(blank, blank)


@pytest.mark.parametrize(
    "image",
    [
        np.zeros((0, 10), dtype=np.uint8),
        np.zeros((10, 10), dtype=np.float32),
        np.zeros((10, 10, 2), dtype=np.uint8),
        np.zeros((10,), dtype=np.uint8),
    ],
)
def test_rejects_invalid_scan_images(image: np.ndarray) -> None:
    with pytest.raises(ValueError, match="정합 이미지"):
        register_page(image, _template())


def test_accepts_color_scan_and_template() -> None:
    gray = _template()
    color = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    result = register_page(color, color)

    assert result.aligned.ndim == 2
    assert result.aligned.dtype == np.uint8


def test_mixed_page_markers_are_reported_as_registration_failure() -> None:
    scan = _template(page_no=1)
    replacement = render_marker(encode_marker_id(2, 0), size_px=90)
    scan[60:150, 60:150] = replacement

    with pytest.raises(RegistrationFailed, match="마커 조합"):
        register_page(scan, _template(page_no=1))
