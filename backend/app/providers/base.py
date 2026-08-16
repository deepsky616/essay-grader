from collections.abc import Callable
from dataclasses import dataclass, field
from threading import RLock
from weakref import ReferenceType, ref

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


@dataclass(frozen=True)
class LLMOutboundRequest(OutboundRequest):
    """완성 어댑터가 받는 검사 대상과 출력 설정의 불변 사본이다."""

    max_output_tokens: int = 32000
    json_output: bool = True

    def __post_init__(self) -> None:
        super().__post_init__()
        if type(self.max_output_tokens) is not int or self.max_output_tokens <= 0:
            raise ValueError("출력 토큰 수는 양의 정수여야 합니다.")
        if type(self.json_output) is not bool:
            raise ValueError("출력 형식 선택은 참 또는 거짓이어야 합니다.")


CompleteAdapter = Callable[[LLMOutboundRequest], LLMResponse]
ListModelsAdapter = Callable[[OutboundRequest], list[str]]


@dataclass(frozen=True)
class _ProviderState:
    gateway: TransmissionGateway
    complete_adapter: CompleteAdapter
    list_models_adapter: ListModelsAdapter


class LLMProvider:
    """전송 관문과 공급자별 원시 어댑터를 묶는 유일한 실행 손잡이다.

    공급자 교체는 이 자료형을 상속하지 않고 두 어댑터 콜백을 합성해서 한다.
    제품 진입점은 이 정확한 자료형만 받아 하위 자료형이나 흉내 객체가 공개
    전송 흐름을 바꾸지 못하게 한다.
    """

    __slots__ = ("__weakref__",)

    def __init_subclass__(cls, **kwargs: object) -> None:
        raise TypeError(
            "LLMProvider 하위 자료형은 지원하지 않습니다. "
            "complete와 list_models 어댑터를 합성하세요."
        )

    def __init__(
        self,
        gateway: TransmissionGateway,
        complete_adapter: CompleteAdapter,
        list_models_adapter: ListModelsAdapter,
    ) -> None:
        if type(self) is not LLMProvider:
            raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")

        identity = id(self)
        with _PROVIDER_STATES_LOCK:
            current = _PROVIDER_STATES.get(identity)
            if current is not None:
                owner = current.handle_ref()
                if owner is self:
                    raise TypeError(
                        "언어 모형 제공자 실행 손잡이는 이미 초기화되었습니다."
                    )
                if owner is not None:
                    raise TypeError(
                        "언어 모형 제공자 실행 손잡이의 정체성이 충돌했습니다."
                    )

            if type(gateway) is not TransmissionGateway:
                raise TypeError(
                    "언어 모형 제공자는 정확한 전송 게이트웨이를 사용해야 합니다."
                )
            if not callable(complete_adapter) or not callable(list_models_adapter):
                raise TypeError("언어 모형 제공자 어댑터는 호출할 수 있어야 합니다.")

            handle_ref = ref(
                self,
                lambda dead_ref, object_id=identity: _cleanup_provider_state(
                    object_id, dead_ref
                ),
            )
            _PROVIDER_STATES[identity] = _ProviderEntry(
                handle_ref=handle_ref,
                state=_ProviderState(
                    gateway=gateway,
                    complete_adapter=complete_adapter,
                    list_models_adapter=list_models_adapter,
                ),
            )

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"언어 모형 제공자 합성은 바꿀 수 없습니다: {name}")

    def complete(self, request: LLMRequest) -> LLMResponse:
        state = self._state()
        outbound = LLMOutboundRequest(
            purpose=request.purpose,
            text_parts=[request.system, request.user_text],
            image_parts=request.images,
            max_output_tokens=request.max_output_tokens,
            json_output=request.json_output,
        )
        return TransmissionGateway.send(
            state.gateway,
            outbound,
            state.complete_adapter,
        )

    def list_models(self) -> list[str]:
        state = self._state()
        request = OutboundRequest(purpose="list_models")
        return TransmissionGateway.send(
            state.gateway,
            request,
            state.list_models_adapter,
        )

    def _state(self) -> _ProviderState:
        if type(self) is not LLMProvider:
            raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")
        with _PROVIDER_STATES_LOCK:
            entry = _PROVIDER_STATES.get(id(self))
            if entry is None or entry.handle_ref() is not self:
                raise TypeError(
                    "초기화된 언어 모형 제공자 실행 손잡이가 필요합니다."
                )
            return entry.state


@dataclass(frozen=True)
class _ProviderEntry:
    handle_ref: ReferenceType[LLMProvider]
    state: _ProviderState


_PROVIDER_STATES: dict[int, _ProviderEntry] = {}
_PROVIDER_STATES_LOCK = RLock()


def _cleanup_provider_state(
    identity: int, dead_ref: ReferenceType[LLMProvider]
) -> None:
    """늦은 정리 콜백이 재사용된 같은 정체성 키를 지우지 않게 한다."""
    with _PROVIDER_STATES_LOCK:
        current = _PROVIDER_STATES.get(identity)
        if current is not None and current.handle_ref is dead_ref:
            del _PROVIDER_STATES[identity]
