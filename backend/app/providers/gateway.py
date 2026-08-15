"""외부 호출을 위한 단일 전송 통로.

외부 제공자는 이 모듈을 거쳐서만 요청을 전송한다. 전송 직전에 등록된
식별정보를 검사하고, 발견하면 제공자 호출 전에 요청을 차단한다.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")


class PIIViolation(Exception):
    """외부 전송 페이로드에 식별정보가 포함됐을 때 발생한다."""


@dataclass
class OutboundRequest:
    """외부 제공자에 전달할 비식별 요청이다."""

    purpose: str
    text_parts: list[str] = field(default_factory=list)
    image_parts: list[bytes] = field(default_factory=list)
    anonymous_token: str | None = None
    provider: str = "unspecified"

    def combined_text(self) -> str:
        """검사와 크기 산정에만 쓸 텍스트를 결합한다."""
        return "\n".join(self.text_parts)

    def payload_bytes(self) -> int:
        """감사용 전송 크기를 계산한다. 내용은 반환하거나 기록하지 않는다."""
        return len(self.combined_text().encode("utf-8")) + sum(
            len(image) for image in self.image_parts
        )


class TransmissionGateway:
    """식별정보 검사를 통과한 요청만 제공자 호출로 전달한다."""

    def __init__(
        self,
        audit_log_path: Path,
        pii_terms_provider: Callable[[], set[str]],
    ) -> None:
        self._audit_log_path = audit_log_path
        self._pii_terms_provider = pii_terms_provider
        self._audit_log_path.parent.mkdir(parents=True, exist_ok=True)

    def send(self, request: OutboundRequest, call: Callable[[OutboundRequest], T]) -> T:
        """검사 실패 시 제공자를 호출하지 않고 전송을 중단한다."""
        found_terms = self._find_pii(request)
        if found_terms:
            self._write_audit(request, "blocked")
            terms = ", ".join(sorted(found_terms))
            raise PIIViolation(
                f"외부 전송 페이로드에 식별정보가 포함되어 있습니다: {terms}. "
                "전송을 중단했습니다."
            )

        self._write_audit(request, "pass")
        return call(request)

    def _find_pii(self, request: OutboundRequest) -> set[str]:
        text = request.combined_text()
        return {
            term
            for term in self._pii_terms_provider()
            if term and term in text
        }

    def _write_audit(self, request: OutboundRequest, pii_check: str) -> None:
        """허용된 메타데이터만 줄 단위로 추가한다."""
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "provider": request.provider,
            "purpose": request.purpose,
            "anonymous_token": request.anonymous_token,
            "payload_bytes": request.payload_bytes(),
            "pii_check": pii_check,
        }
        with self._audit_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
