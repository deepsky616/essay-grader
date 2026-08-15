import json
from types import SimpleNamespace

import pytest

from app.providers.base import LLMProvider, LLMRequest, LLMResponse
from app.api.settings import build_provider
from app.config import settings
from app.providers import gemini_llm
from app.providers.gateway import PIIViolation, TransmissionGateway
from app.providers.gemini_llm import GeminiLLMProvider
from tests.fakes import FakeLLMProvider


def test_provider_subclass_cannot_override_guarded_public_completion():
    with pytest.raises(TypeError, match="complete"):

        class BypassProvider(LLMProvider):
            def complete(self, request):
                return LLMResponse(text="unguarded")

            def _complete(self, request, max_output_tokens, json_output):
                return LLMResponse(text="unused")

            def _list_models(self, request):
                return []


def test_provider_subclass_cannot_override_guarded_public_model_listing():
    with pytest.raises(TypeError, match="list_models"):

        class BypassProvider(LLMProvider):
            def list_models(self):
                return ["unguarded"]

            def _complete(self, request, max_output_tokens, json_output):
                return LLMResponse(text="unused")

            def _list_models(self, request):
                return []


def test_provider_subclass_cannot_empty_guard_set_to_override_public_flow():
    with pytest.raises(TypeError, match="complete"):

        class BypassProvider(LLMProvider):
            _GUARDED_PUBLIC_METHODS = frozenset()

            def complete(self, request):
                return LLMResponse(text="unguarded")

            def _complete(self, request, max_output_tokens, json_output):
                return LLMResponse(text="unused")

            def _list_models(self, request):
                return []


@pytest.mark.parametrize(
    "protected_name",
    ["__getattribute__", "__setattr__", "__init_subclass__"],
)
def test_provider_subclass_cannot_override_boundary_protection_hooks(
    protected_name,
):
    namespace = {
        protected_name: lambda *args, **kwargs: None,
        "_complete": lambda self, request, max_output_tokens, json_output: LLMResponse(
            text="unused"
        ),
        "_list_models": lambda self, request: [],
    }

    with pytest.raises(TypeError, match=protected_name):
        type("BypassProvider", (LLMProvider,), namespace)


@pytest.mark.parametrize("method_name", ["complete", "list_models"])
def test_provider_instance_cannot_replace_guarded_public_method(method_name):
    provider = FakeLLMProvider(responses=[])

    with pytest.raises(AttributeError, match=method_name):
        setattr(provider, method_name, lambda *args: None)


def test_provider_cannot_replace_gateway_with_an_unchecked_sender():
    calls = []

    class UncheckedSender:
        def send(self, request, callback):
            calls.append(request)
            return callback(request)

    class BypassProvider(LLMProvider):
        def __init__(self):
            self._gateway = UncheckedSender()

        def _complete(self, request, max_output_tokens, json_output):
            return LLMResponse(text="unguarded")

        def _list_models(self, request):
            return []

    provider = BypassProvider()

    with pytest.raises(TypeError, match="전송 게이트웨이"):
        provider.complete(LLMRequest(system="s", user_text="김미래"))

    assert calls == []


def test_provider_rejects_transmission_gateway_subclass(tmp_path):
    calls = []
    audit_path = tmp_path / "audit.log"

    class BypassGateway(TransmissionGateway):
        def send(self, request, callback):
            calls.append(request)
            return callback(request)

    gateway = BypassGateway(audit_path, set, "test-provider")

    with pytest.raises(TypeError, match="정확한 전송 게이트웨이"):
        FakeLLMProvider(responses=["unguarded"], gateway=gateway)

    assert calls == []
    assert not audit_path.exists()


def test_transmission_gateway_instance_send_cannot_be_replaced(tmp_path):
    gateway = TransmissionGateway(tmp_path / "audit.log", set, "test-provider")

    with pytest.raises(AttributeError):
        gateway.send = lambda request, callback: callback(request)


def test_fake_provider_completion_instance_shadow_cannot_bypass_gateway(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(
        audit_path,
        pii_terms_provider=lambda: {"김미래"},
        provider="test-provider",
    )
    provider = FakeLLMProvider(responses=["should not be returned"], gateway=gateway)
    bypass_calls = []
    provider.__dict__["complete"] = lambda request: (
        bypass_calls.append(request) or LLMResponse(text="unguarded")
    )

    with pytest.raises(PIIViolation):
        provider.complete(
            LLMRequest(system="안전한 지시", user_text="김미래", images=[])
        )

    assert bypass_calls == []
    assert provider.requests == []
    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["provider"] == "test-provider"
    assert entry["purpose"] == "rubric_compile"
    assert entry["pii_check"] == "blocked"


def test_fake_provider_returns_queued_response():
    provider = FakeLLMProvider(responses=['{"ok": true}'])

    response = provider.complete(
        LLMRequest(system="시스템 지시", user_text="사용자 입력", images=[])
    )

    assert isinstance(response, LLMResponse)
    assert response.text == '{"ok": true}'


def test_fake_provider_records_requests():
    provider = FakeLLMProvider(responses=["a", "b"])

    provider.complete(LLMRequest(system="s", user_text="첫 번째", images=[]))
    provider.complete(LLMRequest(system="s", user_text="두 번째", images=[]))

    assert [request.user_text for request in provider.requests] == [
        "첫 번째",
        "두 번째",
    ]


def test_fake_provider_lists_models():
    provider = FakeLLMProvider(responses=[], models=["gemini-a", "gemini-b"])

    assert provider.list_models() == ["gemini-a", "gemini-b"]


def test_gemini_model_list_instance_shadow_cannot_bypass_gateway_and_audit(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(audit_path, set, "test-provider")
    models = SimpleNamespace(
        list=lambda: [
            SimpleNamespace(name="models/gemini-b", supported_actions=[]),
            SimpleNamespace(
                name="models/not-for-generation", supported_actions=["embedContent"]
            ),
            SimpleNamespace(
                name="models/gemini-a", supported_actions=["generateContent"]
            ),
        ]
    )
    client = SimpleNamespace(models=models)
    provider = GeminiLLMProvider(
        api_key="api-key-secret", model=None, gateway=gateway, client=client
    )
    bypass_calls = []
    provider.__dict__["list_models"] = lambda: (
        bypass_calls.append(True) or ["models/bypass"]
    )

    assert provider.list_models() == ["models/gemini-a", "models/gemini-b"]
    assert bypass_calls == []

    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["provider"] == "test-provider"
    assert entry["purpose"] == "list_models"
    assert entry["payload_bytes"] == 0
    assert "api-key-secret" not in audit_path.read_text(encoding="utf-8")


def test_application_provider_factory_audits_as_gemini(monkeypatch):
    client = SimpleNamespace(models=SimpleNamespace(list=lambda: []))
    monkeypatch.setattr(gemini_llm.genai, "Client", lambda api_key: client)

    provider = build_provider("api-key-secret", None)

    assert provider.list_models() == []
    entry = json.loads(settings.audit_log_path().read_text(encoding="utf-8"))
    assert entry["provider"] == "gemini"
    assert entry["purpose"] == "list_models"
    assert "api-key-secret" not in settings.audit_log_path().read_text(encoding="utf-8")


def test_gemini_completion_sends_the_immutable_checked_copy(tmp_path):
    source_request = LLMRequest(
        system="safe system",
        user_text="safe user",
        max_output_tokens=123,
        json_output=True,
    )
    captured = {}

    class FakeModels:
        def generate_content(self, **arguments):
            captured.update(arguments)
            return SimpleNamespace(text="{}")

    def mutate_source_during_pii_check():
        source_request.user_text = "unchecked secret"
        source_request.max_output_tokens = 999
        source_request.json_output = False
        return set()

    gateway = TransmissionGateway(
        tmp_path / "audit.log",
        mutate_source_during_pii_check,
        "test-provider",
    )
    provider = GeminiLLMProvider(
        api_key="api-key-secret",
        model="models/gemini",
        gateway=gateway,
        client=SimpleNamespace(models=FakeModels()),
    )

    assert provider.complete(source_request).text == "{}"

    sent_part = captured["contents"][0].parts[-1]
    assert sent_part.text == "safe user"
    assert captured["config"].max_output_tokens == 123
    assert captured["config"].response_mime_type == "application/json"
