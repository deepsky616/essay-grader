"""식별정보 영역만 처리하는 로컬 전용 글자 인식 손잡이."""

from typing import Protocol

import cv2
import numpy as np
import pytesseract
from PIL import Image


TESSERACT_LANG = "kor"
TESSERACT_CONFIG = "--psm 7"
TESSERACT_TIMEOUT_SECONDS = 10.0
MAX_IMAGE_PIXELS = 20_000_000
MAX_RESULT_LENGTH = 200


class LocalOCRUnavailable(Exception):
    """지역 실행 파일이나 언어 자료를 안전하게 사용할 수 없을 때 발생한다."""


class LocalOCRProvider(Protocol):
    def recognize(self, image: np.ndarray) -> str: ...


def _gray(image: np.ndarray) -> np.ndarray:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.size == 0
        or image.size > MAX_IMAGE_PIXELS
    ):
        raise ValueError("로컬 글자 인식 입력은 크기가 제한된 8비트 이미지여야 합니다.")
    if image.ndim == 2:
        gray = image
    elif image.ndim == 3 and image.shape[2] == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    elif image.ndim == 3 and image.shape[2] == 4:
        gray = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    else:
        raise ValueError("로컬 글자 인식 이미지 채널 수가 올바르지 않습니다.")
    if min(gray.shape) < 2:
        raise ValueError("로컬 글자 인식 이미지 크기가 너무 작습니다.")
    return np.ascontiguousarray(gray)


class TesseractLocalOCR:
    """한국어 한 줄 영역을 지역 Tesseract 실행 파일로만 읽는다."""

    def recognize(self, image: np.ndarray) -> str:
        gray = _gray(image)
        local_image = Image.fromarray(np.array(gray, copy=True))
        try:
            text = pytesseract.image_to_string(
                local_image,
                lang=TESSERACT_LANG,
                config=TESSERACT_CONFIG,
                timeout=TESSERACT_TIMEOUT_SECONDS,
            )
        except Exception:
            raise LocalOCRUnavailable(
                "로컬 글자 인식기를 사용할 수 없습니다. "
                "실행 파일과 한국어 언어 자료 설치를 확인하세요."
            ) from None

        if type(text) is not str or len(text) > MAX_RESULT_LENGTH:
            raise LocalOCRUnavailable(
                "로컬 글자 인식 결과가 허용 범위를 벗어났습니다."
            )
        return text.strip()
