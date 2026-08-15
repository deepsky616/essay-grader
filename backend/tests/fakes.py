from pathlib import Path
from tempfile import TemporaryDirectory

from app.providers.base import LLMOutboundRequest, LLMProvider, LLMRequest, LLMResponse
from app.providers.gateway import OutboundRequest, TransmissionGateway


class FakeKeyring:
    """실제 운영체제 자격 정보 저장소를 건드리지 않는 시험 대역."""

    def __init__(self, working: bool = True) -> None:
        self._store: dict[tuple[str, str], str] = {}
        self._working = working

    def set_password(self, service: str, name: str, value: str) -> None:
        if not self._working:
            raise RuntimeError("자격 정보 저장소 사용 불가")
        self._store[(service, name)] = value

    def get_password(self, service: str, name: str) -> str | None:
        if not self._working:
            raise RuntimeError("자격 정보 저장소 사용 불가")
        return self._store.get((service, name))

    def delete_password(self, service: str, name: str) -> None:
        if not self._working:
            raise RuntimeError("자격 정보 저장소 사용 불가")
        self._store.pop((service, name), None)


class FakeLLMAdapter:
    """미리 준비한 응답을 돌려주며 검사된 요청을 기록하는 시험 어댑터."""

    def __init__(
        self,
        responses: list[str | Exception],
        models: list[str] | None = None,
    ) -> None:
        self._responses = list(responses)
        self._models = list(models) if models is not None else ["fake-model"]
        self._audit_directory: TemporaryDirectory[str] | None = None
        self.requests: list[LLMRequest] = []

    def complete(
        self,
        request: LLMOutboundRequest,
    ) -> LLMResponse:
        system, user_text = request.text_parts
        self.requests.append(
            LLMRequest(
                system=system,
                user_text=user_text,
                images=list(request.image_parts),
                max_output_tokens=request.max_output_tokens,
                json_output=request.json_output,
                purpose=request.purpose,
            )
        )
        if not self._responses:
            raise AssertionError("시험 제공자에 남은 응답이 없습니다.")
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return LLMResponse(text=response)

    def list_models(self, _request: OutboundRequest) -> list[str]:
        return list(self._models)


def make_fake_llm_provider(
    responses: list[str | Exception],
    models: list[str] | None = None,
    gateway: TransmissionGateway | None = None,
) -> tuple[LLMProvider, FakeLLMAdapter]:
    """시험 어댑터와 정확한 제품 실행 손잡이를 따로 돌려준다."""
    adapter = FakeLLMAdapter(responses=responses, models=models)
    return make_llm_provider(adapter, gateway), adapter


def make_llm_provider(
    adapter: FakeLLMAdapter,
    gateway: TransmissionGateway | None = None,
) -> LLMProvider:
    """주어진 시험 어댑터를 정확한 제품 실행 손잡이에 합성한다."""
    if gateway is None:
        adapter._audit_directory = TemporaryDirectory(prefix="essay-grader-fake-llm-")
        gateway = TransmissionGateway(
            Path(adapter._audit_directory.name) / "audit.log",
            pii_terms_provider=set,
            provider="test-provider",
        )
    provider = LLMProvider(
        gateway=gateway,
        complete_adapter=adapter.complete,
        list_models_adapter=adapter.list_models,
    )
    return provider
