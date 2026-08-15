from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import final

from app.providers.gateway import OutboundRequest, TransmissionGateway


@dataclass
class LLMRequest:
    system: str
    user_text: str
    images: list[bytes] = field(default_factory=list)
    max_output_tokens: int = 32000
    json_output: bool = True
    purpose: str = "rubric_compile"


@dataclass
class LLMResponse:
    text: str


def _require_transmission_gateway(provider: object) -> TransmissionGateway:
    gateway = getattr(provider, "_gateway", None)
    if not isinstance(gateway, TransmissionGateway):
        raise TypeError("언어 모형 제공자는 전송 게이트웨이를 사용해야 합니다.")
    return gateway


class LLMProvider(ABC):
    """모든 언어 모형 제공자가 공유하는 강제 전송 경계다.

    공개 메서드는 요청을 불변 전송 자료로 복사한 뒤 관문으로 보낸다. 하위
    제공자는 검사된 요청을 받는 내부 콜백만 구현할 수 있다.
    """

    _GUARDED_PUBLIC_METHODS = frozenset({"complete", "list_models"})

    def __init_subclass__(cls, **kwargs) -> None:
        super().__init_subclass__(**kwargs)
        overridden = cls._GUARDED_PUBLIC_METHODS.intersection(cls.__dict__)
        if overridden:
            names = ", ".join(sorted(overridden))
            raise TypeError(
                "전송 관문이 소유한 공개 메서드는 다시 정의할 수 없습니다: "
                f"{names}"
            )

    def __init__(self, gateway: TransmissionGateway) -> None:
        if not isinstance(gateway, TransmissionGateway):
            raise TypeError("언어 모형 제공자는 전송 게이트웨이를 사용해야 합니다.")
        self._gateway = gateway

    @final
    def complete(self, request: LLMRequest) -> LLMResponse:
        gateway = _require_transmission_gateway(self)
        max_output_tokens = request.max_output_tokens
        json_output = request.json_output
        outbound = OutboundRequest(
            purpose=request.purpose,
            text_parts=[request.system, request.user_text],
            image_parts=request.images,
        )
        return gateway.send(
            outbound,
            lambda checked: self._complete(
                checked,
                max_output_tokens=max_output_tokens,
                json_output=json_output,
            ),
        )

    @final
    def list_models(self) -> list[str]:
        gateway = _require_transmission_gateway(self)
        request = OutboundRequest(purpose="list_models")
        return gateway.send(request, self._list_models)

    @abstractmethod
    def _complete(
        self,
        request: OutboundRequest,
        max_output_tokens: int,
        json_output: bool,
    ) -> LLMResponse:
        """검사된 완성 요청만 실제 제공자 도구에 전달한다."""

    @abstractmethod
    def _list_models(self, request: OutboundRequest) -> list[str]:
        """검사된 목록 요청만 실제 제공자 도구에 전달한다."""
