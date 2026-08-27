import numpy as np
import pytest

from app.providers.local_ocr import (
    LocalOCRUnavailable,
    TESSERACT_CONFIG,
    TESSERACT_LANG,
    TesseractLocalOCR,
)
from tests.fakes import FakeLocalOCR


def test_fake_returns_queued_text_and_records_copy() -> None:
    image = np.zeros((10, 10), dtype=np.uint8)
    ocr = FakeLocalOCR(["김미래", "박균형"])

    assert ocr.recognize(image) == "김미래"
    image[:] = 255
    assert np.all(ocr.calls[0] == 0)
    assert not ocr.calls[0].flags.writeable
    assert ocr.recognize(image) == "박균형"
    assert ocr.recognize(image) == ""


def test_tesseract_raises_clear_error_when_binary_missing(monkeypatch) -> None:
    import app.providers.local_ocr as module

    def missing(*_args: object, **_kwargs: object) -> str:
        raise FileNotFoundError("/private/path/tesseract")

    monkeypatch.setattr(module.pytesseract, "image_to_string", missing)

    with pytest.raises(LocalOCRUnavailable, match="로컬") as caught:
        TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8))

    assert "/private/path" not in str(caught.value)


def test_tesseract_error_is_sanitized(monkeypatch) -> None:
    import app.providers.local_ocr as module

    def failed(*_args: object, **_kwargs: object) -> str:
        raise module.pytesseract.TesseractError(1, "/private/student/data")

    monkeypatch.setattr(module.pytesseract, "image_to_string", failed)

    with pytest.raises(LocalOCRUnavailable) as caught:
        TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8))

    assert "/private/student" not in str(caught.value)


def test_tesseract_strips_outer_whitespace(monkeypatch) -> None:
    import app.providers.local_ocr as module

    monkeypatch.setattr(
        module.pytesseract,
        "image_to_string",
        lambda *_args, **_kwargs: "  김미래 \n",
    )

    assert TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8)) == "김미래"


def test_tesseract_uses_local_korean_single_line_mode(monkeypatch) -> None:
    import app.providers.local_ocr as module

    captured: dict[str, object] = {}

    def recognize(image: object, **kwargs: object) -> str:
        captured["image"] = image
        captured.update(kwargs)
        return "1"

    monkeypatch.setattr(module.pytesseract, "image_to_string", recognize)
    color = np.zeros((32, 96, 3), dtype=np.uint8)

    assert TesseractLocalOCR().recognize(color) == "1"
    assert captured["lang"] == TESSERACT_LANG
    assert captured["config"] == TESSERACT_CONFIG
    assert captured["timeout"] == 10.0


@pytest.mark.parametrize(
    "image",
    [
        np.zeros((0, 10), dtype=np.uint8),
        np.zeros((10, 10), dtype=np.float32),
        np.zeros((10, 10, 2), dtype=np.uint8),
        np.zeros((10,), dtype=np.uint8),
    ],
)
def test_rejects_invalid_image(image: np.ndarray) -> None:
    with pytest.raises(ValueError, match="로컬"):
        TesseractLocalOCR().recognize(image)


def test_rejects_unexpected_or_oversized_result(monkeypatch) -> None:
    import app.providers.local_ocr as module

    monkeypatch.setattr(
        module.pytesseract,
        "image_to_string",
        lambda *_args, **_kwargs: None,
    )
    with pytest.raises(LocalOCRUnavailable):
        TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8))

    monkeypatch.setattr(
        module.pytesseract,
        "image_to_string",
        lambda *_args, **_kwargs: "가" * 201,
    )
    with pytest.raises(LocalOCRUnavailable):
        TesseractLocalOCR().recognize(np.zeros((32, 96), dtype=np.uint8))
