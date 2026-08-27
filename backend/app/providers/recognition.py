"""설계 문서 7.4절의 후보 분류와 전사 인식 계약."""

import json
import math
from typing import Protocol

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)


MAX_RAW_RESPONSE_LENGTH = 100_000
MAX_CANDIDATES = 500
MAX_SLOTS = 100
MAX_CANDIDATE_LENGTH = 500

CLASSIFY_SYSTEM = """학생 손글씨 답안 이미지를 닫힌 후보 목록으로 분류하세요.
후보 문자열을 고치지 말고 그대로 돌려주세요.
어느 후보도 아니면 none_of_above, 읽을 수 없으면 unreadable을 쓰세요.
억지로 비슷한 후보를 고르지 마세요.
JSON 객체 하나만 출력하세요.
"""

TRANSCRIBE_SYSTEM = """학생 손글씨를 있는 그대로 옮기세요.
맞춤법과 계산을 고치지 말고 읽을 수 없는 글자는 네모 표시로 남기세요.
아무것도 없거나 읽을 수 없으면 unreadable을 쓰세요.
JSON 객체 하나만 출력하세요.
"""


class RecognitionProvider(Protocol):
    def classify(
        self,
        image: bytes,
        candidates: list[str],
        slot_count: int = 1,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse: ...

    def transcribe(
        self,
        image: bytes,
        anonymous_token: str | None = None,
    ) -> RecognizedResponse: ...


def _validate_prompt_inputs(candidates: list[str], slot_count: int) -> None:
    if (
        type(slot_count) is not int
        or not 1 <= slot_count <= MAX_SLOTS
    ):
        raise ValueError("인식 칸 수가 올바르지 않습니다.")
    if (
        type(candidates) is not list
        or not candidates
        or len(candidates) > MAX_CANDIDATES
        or any(
            type(candidate) is not str
            or not candidate.strip()
            or candidate != candidate.strip()
            or len(candidate) > MAX_CANDIDATE_LENGTH
            for candidate in candidates
        )
        or len(set(candidates)) != len(candidates)
    ):
        raise ValueError("인식 후보 목록이 올바르지 않습니다.")


def build_classify_prompt(candidates: list[str], slot_count: int) -> str:
    _validate_prompt_inputs(candidates, slot_count)
    listed = json.dumps(candidates, ensure_ascii=False)
    return (
        f"이 이미지에는 손으로 쓴 답이 {slot_count}개 있습니다.\n"
        f"후보 목록: {listed}\n"
        "후보에 없음은 none_of_above, 판독 불가는 unreadable로 쓰세요.\n"
        f"ok 상태의 values에는 정확히 {slot_count}개를 담으세요."
    )


def _error(kind: RecognitionKind, note: str) -> RecognizedResponse:
    return RecognizedResponse(
        kind=kind,
        status=RecognitionStatus.ERROR,
        confidence=0.0,
        note=note,
    )


def _reject_json_constant(_value: str) -> None:
    raise ValueError("유한한 수가 아닙니다.")


def _payload(raw: str) -> dict[str, object] | None:
    if not isinstance(raw, str) or len(raw) > MAX_RAW_RESPONSE_LENGTH:
        return None
    try:
        parsed = json.loads(raw, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return parsed if type(parsed) is dict else None


def _confidence(value: object) -> float | None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or not 0.0 <= float(value) <= 1.0
    ):
        return None
    return float(value)


def _status(value: object, *, allow_none: bool) -> RecognitionStatus | None:
    if value is None:
        return RecognitionStatus.OK
    try:
        status = RecognitionStatus(value)
    except (TypeError, ValueError):
        return None
    allowed = {RecognitionStatus.OK, RecognitionStatus.UNREADABLE}
    if allow_none:
        allowed.add(RecognitionStatus.NONE_OF_ABOVE)
    return status if status in allowed else None


def parse_classify_output(
    raw: str,
    slot_count: int,
    candidates: list[str] | None = None,
) -> RecognizedResponse:
    if type(slot_count) is not int or not 1 <= slot_count <= MAX_SLOTS:
        return _error(
            RecognitionKind.CLASSIFY,
            "분류 칸 개수가 올바르지 않습니다.",
        )
    payload = _payload(raw)
    if payload is None or set(payload) not in (
        {"values", "confidence"},
        {"values", "status", "confidence"},
    ):
        return _error(
            RecognitionKind.CLASSIFY,
            "분류 응답 형식이 올바르지 않습니다.",
        )

    values = payload.get("values")
    status = _status(payload.get("status"), allow_none=True)
    confidence = _confidence(payload.get("confidence"))
    if (
        type(values) is not list
        or not all(type(value) is str and value.strip() for value in values)
        or status is None
        or confidence is None
    ):
        return _error(
            RecognitionKind.CLASSIFY,
            "분류 응답 형식이 올바르지 않습니다.",
        )

    if status == RecognitionStatus.OK and len(values) != slot_count:
        return _error(
            RecognitionKind.CLASSIFY,
            "분류 값 개수가 예상한 칸 개수와 다릅니다.",
        )
    if status != RecognitionStatus.OK and values:
        return _error(
            RecognitionKind.CLASSIFY,
            "분류 응답 상태와 값이 서로 맞지 않습니다.",
        )
    def is_candidate_value(value: str) -> bool:
        parts = value.split("|")
        return (
            bool(parts)
            and len(set(parts)) == len(parts)
            and all(part in candidates for part in parts)
        )

    if candidates is not None and any(
        not is_candidate_value(value) for value in values
    ):
        return _error(
            RecognitionKind.CLASSIFY,
            "분류 결과에 후보 목록 밖의 값이 있습니다.",
        )

    return RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=status,
        values=values,
        confidence=confidence,
    )


def parse_transcribe_output(raw: str) -> RecognizedResponse:
    payload = _payload(raw)
    if payload is None or set(payload) not in (
        {"text", "confidence"},
        {"text", "status", "confidence"},
    ):
        return _error(
            RecognitionKind.TRANSCRIBE,
            "전사 응답 형식이 올바르지 않습니다.",
        )

    text = payload.get("text")
    status = _status(payload.get("status"), allow_none=False)
    confidence = _confidence(payload.get("confidence"))
    if (
        type(text) is not str
        or len(text) > 20_000
        or status is None
        or confidence is None
    ):
        return _error(
            RecognitionKind.TRANSCRIBE,
            "전사 응답 형식이 올바르지 않습니다.",
        )
    if status == RecognitionStatus.OK and not text.strip():
        return _error(
            RecognitionKind.TRANSCRIBE,
            "전사 성공 응답에 글이 없습니다.",
        )
    if status != RecognitionStatus.OK and text:
        return _error(
            RecognitionKind.TRANSCRIBE,
            "전사 응답 상태와 글이 서로 맞지 않습니다.",
        )

    return RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=status,
        text=text,
        confidence=confidence,
    )
