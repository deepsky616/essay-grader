import cv2
import numpy as np
import pytest

from app.services.ink_extract import extract_ink, ink_ratio, is_blank_page


def _template(width: int = 400, height: int = 500) -> np.ndarray:
    page = np.full((height, width), 255, dtype=np.uint8)
    for x in range(0, width, 50):
        cv2.line(page, (x, 0), (x, height), 200, 1)
    for y in range(0, height, 50):
        cv2.line(page, (0, y), (width, y), 200, 1)
    cv2.rectangle(page, (30, 30), (370, 200), 0, 2)
    return page


def _with_handwriting(template: np.ndarray) -> np.ndarray:
    page = template.copy()
    cv2.line(page, (60, 300), (300, 380), 0, 4)
    cv2.circle(page, (200, 430), 25, 0, 4)
    return page


def test_removes_printed_elements() -> None:
    template = _template()
    ink = extract_ink(template, template)

    assert ink_ratio(ink) < 0.005
    assert set(np.unique(ink)) <= {0, 255}
    assert not ink.flags.writeable


def test_keeps_handwriting() -> None:
    template = _template()
    ink = extract_ink(_with_handwriting(template), template)

    assert ink[430, 175] > 0 or ink[430, 225] > 0
    assert ink[30, 200] == 0


def test_ink_ratio_increases_with_handwriting() -> None:
    template = _template()
    empty = ink_ratio(extract_ink(template, template))
    written = ink_ratio(extract_ink(_with_handwriting(template), template))

    assert written > empty + 0.005


def test_blank_page_detection() -> None:
    template = _template()

    assert is_blank_page(template, template)
    assert not is_blank_page(_with_handwriting(template), template)


def test_tolerates_uniform_brightness_shift() -> None:
    template = _template()
    darker = np.clip(template.astype(int) - 30, 0, 255).astype(np.uint8)
    ink = extract_ink(darker, template)

    assert ink_ratio(ink) < 0.02


def test_tolerates_smooth_brightness_gradient() -> None:
    template = _template()
    gradient = np.linspace(0.72, 1.0, template.shape[1], dtype=np.float32)
    scan = np.clip(template.astype(np.float32) * gradient, 0, 255).astype(np.uint8)

    assert ink_ratio(extract_ink(scan, template)) < 0.02


def test_tolerates_small_registration_error() -> None:
    template = _template()
    matrix = np.float32([[1, 0, 1.5], [0, 1, 1.0]])
    shifted = cv2.warpAffine(template, matrix, (400, 500), borderValue=255)
    ink = extract_ink(shifted, template)

    assert ink_ratio(ink) < 0.02


def test_accepts_color_input_and_returns_grayscale_mask() -> None:
    template = _template()
    scan = _with_handwriting(template)
    color_scan = cv2.cvtColor(scan, cv2.COLOR_GRAY2BGR)
    color_template = cv2.cvtColor(template, cv2.COLOR_GRAY2BGRA)

    ink = extract_ink(color_scan, color_template)

    assert ink.shape == template.shape
    assert ink.dtype == np.uint8


def test_inputs_are_not_modified() -> None:
    template = _template()
    scan = _with_handwriting(template)
    original_template = template.copy()
    original_scan = scan.copy()

    extract_ink(scan, template)

    assert np.array_equal(scan, original_scan)
    assert np.array_equal(template, original_template)


@pytest.mark.parametrize(
    ("scan", "template"),
    [
        (np.zeros((0, 2), dtype=np.uint8), np.zeros((0, 2), dtype=np.uint8)),
        (np.zeros((10, 10), dtype=np.float32), np.zeros((10, 10), dtype=np.uint8)),
        (np.zeros((10, 10, 2), dtype=np.uint8), np.zeros((10, 10), dtype=np.uint8)),
        (np.zeros((10, 10), dtype=np.uint8), np.zeros((11, 10), dtype=np.uint8)),
    ],
)
def test_rejects_invalid_inputs(scan: np.ndarray, template: np.ndarray) -> None:
    with pytest.raises(ValueError, match="필기 추출"):
        extract_ink(scan, template)


def test_ink_ratio_rejects_non_binary_mask() -> None:
    with pytest.raises(ValueError, match="잉크 마스크"):
        ink_ratio(np.full((10, 10), 12, dtype=np.uint8))


def test_ink_ratio_of_empty_binary_mask_is_zero() -> None:
    assert ink_ratio(np.zeros((0, 0), dtype=np.uint8)) == 0.0
