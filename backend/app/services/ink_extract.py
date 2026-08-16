"""정합된 스캔에서 인쇄 요소를 빼고 학생 필기 마스크를 만든다."""

import cv2
import numpy as np


DIFF_THRESHOLD = 45
TEMPLATE_DILATE_PX = 3
TEMPLATE_INK_MAX = 235
BLANK_INK_RATIO = 0.002
MAX_IMAGE_PIXELS = 100_000_000


def _gray(image: np.ndarray) -> np.ndarray:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.size == 0
        or image.size > MAX_IMAGE_PIXELS
    ):
        raise ValueError("필기 추출 입력은 크기가 제한된 8비트 이미지여야 합니다.")
    if image.ndim == 2:
        result = image
    elif image.ndim == 3 and image.shape[2] == 3:
        result = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    elif image.ndim == 3 and image.shape[2] == 4:
        result = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    else:
        raise ValueError("필기 추출 이미지 채널 수가 올바르지 않습니다.")
    if min(result.shape) < 3:
        raise ValueError("필기 추출 이미지 크기가 너무 작습니다.")
    return np.ascontiguousarray(result)


def _normalize_illumination(image: np.ndarray) -> np.ndarray:
    background = cv2.GaussianBlur(image, (0, 0), sigmaX=25, sigmaY=25)
    safe_background = np.maximum(background, 1)
    normalized = (
        image.astype(np.float32)
        / safe_background.astype(np.float32)
        * 255.0
    )
    return np.clip(normalized, 0, 255).astype(np.uint8)


def extract_ink(aligned_scan: np.ndarray, template: np.ndarray) -> np.ndarray:
    """학생 필기로 추정한 화소만 255인 읽기 전용 마스크를 돌려준다."""
    scan_gray = _gray(aligned_scan)
    template_gray = _gray(template)
    if scan_gray.shape != template_gray.shape:
        raise ValueError("필기 추출 스캔과 템플릿 크기가 다릅니다.")

    scan_normalized = _normalize_illumination(scan_gray)
    template_normalized = _normalize_illumination(template_gray)
    darker = cv2.subtract(template_normalized, scan_normalized)
    _threshold, candidate = cv2.threshold(
        darker,
        DIFF_THRESHOLD,
        255,
        cv2.THRESH_BINARY,
    )

    printed = np.where(template_gray <= TEMPLATE_INK_MAX, 255, 0).astype(np.uint8)
    kernel_size = TEMPLATE_DILATE_PX * 2 + 1
    printed_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (kernel_size, kernel_size),
    )
    printed_dilated = cv2.dilate(printed, printed_kernel)
    ink = cv2.bitwise_and(candidate, cv2.bitwise_not(printed_dilated))

    noise_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned = cv2.morphologyEx(ink, cv2.MORPH_OPEN, noise_kernel)
    result = np.ascontiguousarray(cleaned, dtype=np.uint8)
    result.setflags(write=False)
    return result


def ink_ratio(ink_mask: np.ndarray) -> float:
    if (
        not isinstance(ink_mask, np.ndarray)
        or ink_mask.dtype != np.uint8
        or ink_mask.ndim != 2
        or not np.all((ink_mask == 0) | (ink_mask == 255))
    ):
        raise ValueError("잉크 마스크는 0과 255로 된 8비트 이미지여야 합니다.")
    if ink_mask.size == 0:
        return 0.0
    return float(np.count_nonzero(ink_mask)) / float(ink_mask.size)


def is_blank_page(aligned_scan: np.ndarray, template: np.ndarray) -> bool:
    return ink_ratio(extract_ink(aligned_scan, template)) < BLANK_INK_RATIO
