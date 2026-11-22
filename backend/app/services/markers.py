"""ArUco 마커 하나로 쪽 번호와 네 모서리 정합점을 얻는다."""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import cv2
import numpy as np


CORNERS = 4
ARUCO_DICT = cv2.aruco.DICT_4X4_250
DICT_CAPACITY = 250
MAX_PAGES = DICT_CAPACITY // CORNERS
MAX_USED_MARKER_ID = MAX_PAGES * CORNERS - 1
CORNER_NAMES = ("좌상", "우상", "우하", "좌하")


class MarkerDetectionError(ValueError):
    """검출된 마커 조합으로 한 쪽을 안전하게 정할 수 없을 때 발생한다."""


def encode_marker_id(page_no: int, corner: int) -> int:
    if type(page_no) is not int or not 1 <= page_no <= MAX_PAGES:
        raise ValueError("쪽 번호가 지원 범위를 벗어났습니다.")
    if type(corner) is not int or not 0 <= corner < CORNERS:
        raise ValueError("모서리 번호가 지원 범위를 벗어났습니다.")
    return (page_no - 1) * CORNERS + corner


def decode_marker_id(marker_id: int) -> tuple[int, int]:
    if (
        type(marker_id) is not int
        or marker_id < 0
        or marker_id > MAX_USED_MARKER_ID
    ):
        raise ValueError("예약되지 않은 마커 번호입니다.")
    return marker_id // CORNERS + 1, marker_id % CORNERS


def _dictionary() -> Any:
    return cv2.aruco.getPredefinedDictionary(ARUCO_DICT)


def render_marker(marker_id: int, size_px: int) -> np.ndarray:
    """지원 범위의 단일 마커를 흑백 이미지로 그린다."""
    decode_marker_id(marker_id)
    if type(size_px) is not int or size_px < 8:
        raise ValueError("마커 크기는 여덟 화소 이상 정수여야 합니다.")
    image = cv2.aruco.generateImageMarker(
        _dictionary(),
        marker_id,
        size_px,
    )
    return np.asarray(image, dtype=np.uint8)


@dataclass(frozen=True)
class DetectedPage:
    page_no: int
    corner_points: Mapping[int, tuple[float, float]]

    def __post_init__(self) -> None:
        encode_marker_id(self.page_no, 0)
        checked: dict[int, tuple[float, float]] = {}
        for corner, point in self.corner_points.items():
            if type(corner) is not int or not 0 <= corner < CORNERS:
                raise ValueError("검출 모서리 번호가 올바르지 않습니다.")
            if (
                type(point) is not tuple
                or len(point) != 2
                or not all(type(value) is float for value in point)
            ):
                raise ValueError("검출 좌표가 올바르지 않습니다.")
            checked[corner] = point
        object.__setattr__(self, "corner_points", MappingProxyType(checked))

    @property
    def is_complete(self) -> bool:
        return len(self.corner_points) == CORNERS

    def missing_corners(self) -> list[str]:
        return [
            CORNER_NAMES[corner]
            for corner in range(CORNERS)
            if corner not in self.corner_points
        ]


def _grayscale(image: Any) -> np.ndarray:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.size == 0
    ):
        raise ValueError("마커 검출 입력은 비어 있지 않은 8비트 이미지여야 합니다.")
    if image.ndim == 2:
        return np.ascontiguousarray(image)
    if image.ndim == 3 and image.shape[2] == 3:
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if image.ndim == 3 and image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    raise ValueError("마커 검출 이미지 채널 수가 올바르지 않습니다.")


def detect_page_markers(image: np.ndarray) -> DetectedPage | None:
    """한 장의 마커를 검출하며 혼합 쪽과 중복 모서리는 닫아서 거절한다."""
    gray = _grayscale(image)
    detector = cv2.aruco.ArucoDetector(
        _dictionary(),
        cv2.aruco.DetectorParameters(),
    )
    marker_corners, ids, _rejected = detector.detectMarkers(gray)
    if ids is None or len(ids) == 0:
        return None

    page_no: int | None = None
    points: dict[int, tuple[float, float]] = {}
    for corners, raw_marker_id in zip(
        marker_corners,
        ids.flatten(),
        strict=True,
    ):
        try:
            detected_page, corner = decode_marker_id(int(raw_marker_id))
        except ValueError:
            raise MarkerDetectionError(
                "예약되지 않은 마커가 검출되었습니다."
            ) from None
        if page_no is None:
            page_no = detected_page
        elif detected_page != page_no:
            raise MarkerDetectionError(
                "한 이미지에서 여러 쪽의 마커가 검출되었습니다."
            )
        if corner in points:
            raise MarkerDetectionError(
                "같은 모서리 마커가 중복 검출되었습니다."
            )
        center = np.asarray(corners, dtype=np.float64).reshape(-1, 2).mean(axis=0)
        points[corner] = (float(center[0]), float(center[1]))

    assert page_no is not None
    return DetectedPage(page_no=page_no, corner_points=points)
