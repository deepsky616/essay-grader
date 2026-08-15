from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import final

from app.providers.gateway import OutboundRequest, TransmissionGateway


_SEALED_PUBLIC_METHODS = frozenset({"complete", "list_models"})
_SEALED_PROVIDER_OVERRIDES = _SEALED_PUBLIC_METHODS | frozenset(
    {"__getattribute__", "__setattr__", "__init_subclass__"}
)


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
    if type(gateway) is not TransmissionGateway:
        raise TypeError("언어 모형 제공자는 정확한 전송 게이트웨이를 사용해야 합니다.")
    return gateway


class LLMProvider(ABC):
    """모든 언어 모형 제공자가 공유하는 강제 전송 경계다.

    공개 메서드는 요청을 불변 전송 자료로 복사한 뒤 관문으로 보낸다. 하위
    제공자는 검사된 요청을 받는 내부 콜백만 구현할 수 있다.
    """

    def __init_subclass__(cls, **kwargs) -> None:
        super().__init_subclass__(**kwargs)
        overridden = _SEALED_PROVIDER_OVERRIDES.intersection(cls.__dict__)
        if overridden:
            names = ", ".join(sorted(overridden))
            raise TypeError(
                "전송 관문이 소유한 제공자 메서드는 다시 정의할 수 없습니다: "
                f"{names}"
            )

    def __getattribute__(self, name: str):
        if name == "complete":
            return LLMProvider.complete.__get__(self, type(self))
        if name == "list_models":
            return LLMProvider.list_models.__get__(self, type(self))
        return object.__getattribute__(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        if name in _SEALED_PUBLIC_METHODS:
            raise AttributeError(f"보호된 제공자 메서드는 바꿀 수 없습니다: {name}")
        object.__setattr__(self, name, value)

    def __init__(self, gateway: TransmissionGateway) -> None:
        if type(gateway) is not TransmissionGateway:
            raise TypeError("언어 모형 제공자는 정확한 전송 게이트웨이를 사용해야 합니다.")
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
        return TransmissionGateway.send(
            gateway,
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
        return TransmissionGateway.send(gateway, request, self._list_models)

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
