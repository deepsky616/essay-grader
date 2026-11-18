"""스캔 쪽을 답안지 템플릿 좌표계로 맞춘다.

완전한 네 마커가 있으면 결정론적 대응점을 우선한다. 마커를 넣기 전의 기존
양식처럼 양쪽 모두 마커가 없을 때만 ORB 특징점과 RANSAC을 쓴다. 일부 마커나
서로 다른 쪽 번호는 더 약한 방식으로 숨기지 않고 실패시킨다.
"""

from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

from app.services.markers import (
    CORNERS,
    DetectedPage,
    MarkerDetectionError,
    detect_page_markers,
)


MIN_FEATURE_MATCHES = 12
MIN_FEATURE_INLIERS = 10
MIN_FEATURE_QUALITY = 0.30
MAX_IMAGE_PIXELS = 100_000_000


class RegistrationFailed(Exception):
    """스캔을 템플릿에 안전하게 맞출 수 없을 때 발생한다."""


@dataclass(frozen=True)
class Registered:
    page_no: int | None
    aligned: np.ndarray
    quality: float
    method: Literal["markers", "features"]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.aligned, np.ndarray)
            or self.aligned.dtype != np.uint8
            or self.aligned.ndim != 2
            or self.aligned.size == 0
        ):
            raise ValueError("정합 결과 이미지가 올바르지 않습니다.")
        if type(self.quality) is not float or not 0.0 <= self.quality <= 1.0:
            raise ValueError("정합 품질 점수가 올바르지 않습니다.")
        self.aligned.setflags(write=False)


def _to_gray(image: np.ndarray) -> np.ndarray:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.size == 0
        or image.size > MAX_IMAGE_PIXELS
    ):
        raise ValueError("정합 이미지는 크기가 제한된 8비트 이미지여야 합니다.")
    if image.ndim == 2:
        gray = image
    elif image.ndim == 3 and image.shape[2] == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    elif image.ndim == 3 and image.shape[2] == 4:
        gray = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    else:
        raise ValueError("정합 이미지 채널 수가 올바르지 않습니다.")
    if min(gray.shape) < 8:
        raise ValueError("정합 이미지 크기가 너무 작습니다.")
    return np.ascontiguousarray(gray)


def _detect(image: np.ndarray) -> DetectedPage | None:
    try:
        return detect_page_markers(image)
    except MarkerDetectionError as exc:
        raise RegistrationFailed(
            "정합할 수 없는 마커 조합이 검출되었습니다."
        ) from exc


def _checked_homography(homography: np.ndarray | None) -> np.ndarray:
    if (
        homography is None
        or homography.shape != (3, 3)
        or not np.isfinite(homography).all()
        or abs(float(np.linalg.det(homography))) < 1e-12
        or float(np.linalg.cond(homography)) > 1e10
    ):
        raise RegistrationFailed("안정적인 정합 변환을 계산하지 못했습니다.")
    return homography


def _warp(
    scan: np.ndarray,
    template: np.ndarray,
    homography: np.ndarray,
) -> np.ndarray:
    height, width = template.shape
    try:
        aligned = cv2.warpPerspective(
            scan,
            homography,
            (width, height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=255,
        )
    except cv2.error as exc:
        raise RegistrationFailed("페이지 정합 변환을 적용하지 못했습니다.") from exc
    return np.ascontiguousarray(aligned, dtype=np.uint8)


def _marker_registration(
    scan: np.ndarray,
    template: np.ndarray,
    scan_markers: DetectedPage,
    template_markers: DetectedPage,
) -> Registered:
    if scan_markers.page_no != template_markers.page_no:
        raise RegistrationFailed("스캔과 템플릿의 쪽 번호가 다릅니다.")
    if not scan_markers.is_complete or not template_markers.is_complete:
        missing = sorted(
            set(scan_markers.missing_corners())
            | set(template_markers.missing_corners())
        )
        detail = ", ".join(missing) if missing else "알 수 없는"
        raise RegistrationFailed(
            f"정합에 필요한 모서리 마커가 부족합니다. 빠진 위치: {detail}."
        )

    order = range(CORNERS)
    source = np.asarray(
        [scan_markers.corner_points[corner] for corner in order],
        dtype=np.float32,
    )
    destination = np.asarray(
        [template_markers.corner_points[corner] for corner in order],
        dtype=np.float32,
    )
    homography = _checked_homography(
        cv2.getPerspectiveTransform(source, destination)
    )
    aligned = _warp(scan, template, homography)

    projected = cv2.perspectiveTransform(
        source.reshape(-1, 1, 2),
        homography,
    ).reshape(-1, 2)
    residual = float(np.mean(np.linalg.norm(projected - destination, axis=1)))
    diagonal = max(float(np.hypot(*template.shape)), 1.0)
    quality = float(np.clip(1.0 - residual / (diagonal * 0.01), 0.0, 1.0))
    return Registered(
        page_no=scan_markers.page_no,
        aligned=aligned,
        quality=quality,
        method="markers",
    )


def _feature_registration(scan: np.ndarray, template: np.ndarray) -> Registered:
    detector = cv2.ORB_create(nfeatures=4000, fastThreshold=8)
    source_points, source_descriptors = detector.detectAndCompute(scan, None)
    target_points, target_descriptors = detector.detectAndCompute(template, None)
    if (
        source_descriptors is None
        or target_descriptors is None
        or len(source_points) < MIN_FEATURE_MATCHES
        or len(target_points) < MIN_FEATURE_MATCHES
    ):
        raise RegistrationFailed("정합에 필요한 특징점을 충분히 찾지 못했습니다.")

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    pairs = matcher.knnMatch(source_descriptors, target_descriptors, k=2)
    matches = [
        first
        for pair in pairs
        if len(pair) == 2
        for first, second in [pair]
        if first.distance < 0.75 * second.distance
    ]
    if len(matches) < MIN_FEATURE_MATCHES:
        raise RegistrationFailed("정합에 필요한 특징점 대응이 부족합니다.")

    source = np.asarray(
        [source_points[match.queryIdx].pt for match in matches],
        dtype=np.float32,
    )
    destination = np.asarray(
        [target_points[match.trainIdx].pt for match in matches],
        dtype=np.float32,
    )
    homography, mask = cv2.findHomography(
        source,
        destination,
        cv2.RANSAC,
        ransacReprojThreshold=4.0,
    )
    homography = _checked_homography(homography)
    if mask is None:
        raise RegistrationFailed("특징점 정합 품질을 계산하지 못했습니다.")
    inliers = int(mask.ravel().sum())
    quality = float(inliers / len(matches))
    if inliers < MIN_FEATURE_INLIERS or quality < MIN_FEATURE_QUALITY:
        raise RegistrationFailed("특징점 정합 품질이 기준보다 낮습니다.")

    return Registered(
        page_no=None,
        aligned=_warp(scan, template, homography),
        quality=quality,
        method="features",
    )


def register_page(scan: np.ndarray, template: np.ndarray) -> Registered:
    """마커 우선, 기존 무마커 양식은 특징점 방식으로 정합한다."""
    scan_gray = _to_gray(scan)
    template_gray = _to_gray(template)
    scan_markers = _detect(scan_gray)
    template_markers = _detect(template_gray)

    if scan_markers is not None and template_markers is not None:
        return _marker_registration(
            scan_gray,
            template_gray,
            scan_markers,
            template_markers,
        )
    if scan_markers is None and template_markers is None:
        return _feature_registration(scan_gray, template_gray)
    if scan_markers is None:
        raise RegistrationFailed("스캔 페이지에서 마커를 찾지 못했습니다.")
    raise RegistrationFailed("템플릿에서 마커를 찾지 못했습니다.")
