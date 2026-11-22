import pytest
from pydantic import ValidationError

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)


def test_classified_response_holds_chosen_candidate():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.OK,
        values=["10,000"],
        confidence=0.94,
    )
    assert response.values == ["10,000"]
    assert response.is_usable


def test_unreadable_response_is_not_usable():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.UNREADABLE,
        values=[],
        confidence=0.0,
    )
    assert not response.is_usable


def test_none_of_the_above_is_usable_but_empty():
    response = RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=RecognitionStatus.NONE_OF_ABOVE,
        values=[],
        confidence=0.88,
    )
    assert response.is_usable
    assert response.values == []


def test_transcribed_response_holds_text():
    response = RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.OK,
        text="형광펜은 180÷720×100=25%",
        confidence=0.71,
    )
    assert "25%" in response.text


def test_confidence_must_be_within_range():
    with pytest.raises(ValidationError):
        RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.OK,
            values=["a"],
            confidence=1.4,
        )


def test_skipped_response_for_drawing_items():
    response = RecognizedResponse(
        kind=RecognitionKind.SKIPPED,
        status=RecognitionStatus.SKIPPED,
        confidence=0.0,
    )
    assert not response.is_usable


@pytest.mark.parametrize(
    ("kind", "status"),
    [
        (RecognitionKind.CLASSIFY, RecognitionStatus.SKIPPED),
        (RecognitionKind.TRANSCRIBE, RecognitionStatus.NONE_OF_ABOVE),
        (RecognitionKind.SKIPPED, RecognitionStatus.OK),
    ],
)
def test_kind_and_status_must_agree(kind, status):
    with pytest.raises(ValidationError, match="종류와 상태"):
        RecognizedResponse(kind=kind, status=status, confidence=0.0)


def test_successful_classification_requires_a_value():
    with pytest.raises(ValidationError, match="후보 값"):
        RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.OK,
            confidence=0.8,
        )


def test_successful_transcription_requires_text():
    with pytest.raises(ValidationError, match="전사 글"):
        RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            confidence=0.8,
        )


def test_non_success_status_cannot_carry_recognized_content():
    with pytest.raises(ValidationError, match="인식 내용"):
        RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.UNREADABLE,
            values=["10,000"],
            confidence=0.0,
        )


def test_extra_fields_are_rejected():
    with pytest.raises(ValidationError):
        RecognizedResponse(
            kind=RecognitionKind.CLASSIFY,
            status=RecognitionStatus.OK,
            values=["10,000"],
            confidence=0.9,
            student_name="민감한 값",
        )
