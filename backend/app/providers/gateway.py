"""외부 호출을 위한 단일 전송 통로.

외부 제공자는 이 모듈을 거쳐서만 요청을 전송한다. 전송 직전에 등록된
식별정보를 검사하고, 발견하면 제공자 호출 전에 요청을 차단한다.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar
from unicodedata import normalize

T = TypeVar("T")

_ALLOWED_PROVIDERS = frozenset({"gemini", "test-provider"})
_ALLOWED_PURPOSES = frozenset(
    {
        "rubric_compile",
        "grade_open_text",
        "recognize_classify",
        "recognize_transcribe",
        "generate_feedback",
    }
)
_ANONYMOUS_TOKEN = re.compile(r"S-[0-9a-f]{8}", re.ASCII)
# 유니코드 16.0.0 DerivedCoreProperties의
# Default_Ignorable_Code_Point 전체 범위다. 런타임 유니코드 자료에 의존하지
# 않아 동작이 버전 변화로 달라지지 않도록 고정한다.
_DEFAULT_IGNORABLE_RANGES_UNICODE_16_0 = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)


class PIIViolation(Exception):
    """외부 전송 페이로드에 식별정보가 포함됐을 때 발생한다."""


@dataclass(frozen=True)
class OutboundRequest:
    """외부 제공자에 전달할 비식별 요청이다."""

    purpose: str
    text_parts: tuple[str, ...] | list[str] = field(default_factory=tuple)
    image_parts: tuple[bytes, ...] | list[bytes] = field(default_factory=tuple)
    anonymous_token: str | None = None

    def __post_init__(self) -> None:
        """입력을 안전한 불변 값으로 복사하고 감사 메타자료를 검증한다."""
        self._validate_metadata()
        if not all(isinstance(part, str) for part in self.text_parts):
            raise ValueError("텍스트 부분은 문자열이어야 합니다.")
        try:
            image_parts = tuple(bytes(image) for image in self.image_parts)
        except (TypeError, ValueError) as error:
            raise ValueError("이미지 부분은 바이트열이어야 합니다.") from error

        object.__setattr__(self, "text_parts", tuple(self.text_parts))
        object.__setattr__(self, "image_parts", image_parts)

    def _validate_metadata(self) -> None:
        if self.purpose not in _ALLOWED_PURPOSES:
            raise ValueError("허용되지 않은 요청 종류입니다.")
        if self.anonymous_token is not None and (
            not isinstance(self.anonymous_token, str)
            or not _ANONYMOUS_TOKEN.fullmatch(self.anonymous_token)
        ):
            raise ValueError("익명 토큰 형식이 올바르지 않습니다.")

    def combined_text(self) -> str:
        """검사와 크기 산정에만 쓸 텍스트를 결합한다."""
        return "\n".join(self.text_parts)

    def logical_payload_bytes(self) -> int:
        """검사한 논리 본문과 원본 그림의 바이트 수만 계산한다.

        제공자 도구가 내부적으로 덧붙이는 통신 포장 크기는 추정하거나 기록하지
        않는다. 내용 자체는 반환하거나 감사 기록에 넣지 않는다.
        """
        return len(self.combined_text().encode("utf-8")) + sum(
            len(image) for image in self.image_parts
        )


class TransmissionGateway:
    """식별정보 검사를 통과한 요청만 제공자 호출로 전달한다."""

    def __init__(
        self,
        audit_log_path: Path,
        pii_terms_provider: Callable[[], set[str]],
        provider: str,
    ) -> None:
        if provider not in _ALLOWED_PROVIDERS:
            raise ValueError("허용되지 않은 제공자입니다.")
        self._audit_log_path = audit_log_path
        self._pii_terms_provider = pii_terms_provider
        self._provider = provider
        self._audit_log_path.parent.mkdir(parents=True, exist_ok=True)

    def send(self, request: OutboundRequest, call: Callable[[OutboundRequest], T]) -> T:
        """검사 실패 시 제공자를 호출하지 않고 전송을 중단한다."""
        found_terms = self._find_pii(request)
        if found_terms:
            self._write_audit(request, "blocked")
            raise PIIViolation(
                f"외부 전송에서 식별정보 {len(found_terms)}건이 발견되었습니다. "
                "전송을 중단했습니다."
            )

        self._write_audit(request, "pass")
        return call(request)

    def _find_pii(self, request: OutboundRequest) -> set[str]:
        text = _comparison_text(request.combined_text())
        found_terms: set[str] = set()
        for term in self._pii_terms_provider():
            normalized_term = _comparison_text(term)
            if normalized_term and normalized_term in text:
                found_terms.add(term)
        return found_terms

    def _write_audit(self, request: OutboundRequest, pii_check: str) -> None:
        """허용된 메타데이터만 줄 단위로 추가한다."""
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "provider": self._provider,
            "purpose": request.purpose,
            "anonymous_token": request.anonymous_token,
            "payload_bytes": request.logical_payload_bytes(),
            "pii_check": pii_check,
        }
        with self._audit_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _comparison_text(value: str) -> str:
    """비교 전 유니코드 16.0.0 기본 무시 글자를 제거한다.

    한글을 포함한 일반 문자를 보존하기 위해 결합 문자 범주 전체를 지우지
    않고, 고정한 기본 무시 글자 범위만 제거한다. 실제 전송 본문은 바꾸지 않는다.
    """
    return "".join(
        character
        for character in normalize("NFC", value)
        if not _is_basic_ignorable(character)
    )


def _is_basic_ignorable(character: str) -> bool:
    codepoint = ord(character)
    return any(
        start <= codepoint <= end
        for start, end in _DEFAULT_IGNORABLE_RANGES_UNICODE_16_0
    )
