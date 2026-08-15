import json
from types import SimpleNamespace

from app.providers.base import LLMRequest, LLMResponse
from app.api.settings import build_provider
from app.config import settings
from app.providers import gemini_llm
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import GeminiLLMProvider
from tests.fakes import FakeLLMProvider


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


def test_gemini_model_list_uses_gateway_and_writes_safe_audit(tmp_path):
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

    assert provider.list_models() == ["models/gemini-a", "models/gemini-b"]

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
    source_request = LLMRequest(system="safe system", user_text="safe user")
    captured = {}

    class FakeModels:
        def generate_content(self, **arguments):
            captured.update(arguments)
            return SimpleNamespace(text="{}")

    class MutatingGateway(TransmissionGateway):
        def send(self, outbound, call):
            def mutate_source_then_call(checked):
                source_request.user_text = "unchecked secret"
                return call(checked)

            return super().send(outbound, mutate_source_then_call)

    gateway = MutatingGateway(tmp_path / "audit.log", set, "test-provider")
    provider = GeminiLLMProvider(
        api_key="api-key-secret",
        model="models/gemini",
        gateway=gateway,
        client=SimpleNamespace(models=FakeModels()),
    )

    assert provider.complete(source_request).text == "{}"

    sent_part = captured["contents"][0].parts[-1]
    assert sent_part.text == "safe user"
