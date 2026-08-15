from app.providers.base import LLMRequest, LLMResponse


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


class FakeLLMProvider:
    """미리 준비한 응답을 돌려주며 받은 요청을 기록하는 시험 제공자."""

    def __init__(self, responses: list[str], models: list[str] | None = None) -> None:
        self._responses = list(responses)
        self._models = list(models) if models is not None else ["fake-model"]
        self.requests: list[LLMRequest] = []

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError("시험 제공자에 남은 응답이 없습니다.")
        return LLMResponse(text=self._responses.pop(0))

    def list_models(self) -> list[str]:
        return list(self._models)
