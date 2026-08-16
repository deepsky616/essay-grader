import gc
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from weakref import ref

import pytest
from google.genai import types as genai_types

from app.api.settings import build_provider
from app.config import settings
from app.providers import base as provider_base
from app.providers import gemini_llm
from app.providers.base import LLMOutboundRequest, LLMProvider, LLMRequest, LLMResponse
from app.providers.gateway import (
    OutboundRequest,
    PIIViolation,
    TransmissionGateway,
)
from app.providers.gemini_llm import create_gemini_provider
from tests.fakes import FakeLLMAdapter, make_fake_llm_provider


def test_provider_callback_cycles_are_collected_without_state_table_leaks(
    tmp_path,
):
    gc.collect()
    original_state_keys = set(provider_base._PROVIDER_STATES)

    def make_cyclic_provider(index):
        provider = None

        def complete_adapter(_request):
            assert provider is not None
            return LLMResponse(text="unused")

        def list_models_adapter(_request):
            assert provider is not None
            return []

        provider = LLMProvider(
            TransmissionGateway(
                tmp_path / f"cyclic-{index}.log", set, "test-provider"
            ),
            complete_adapter,
            list_models_adapter,
        )
        return ref(provider)

    gc_was_enabled = gc.isenabled()
    gc.disable()
    try:
        provider_refs = [make_cyclic_provider(index) for index in range(100)]
        assert all(provider_ref() is not None for provider_ref in provider_refs)
    finally:
        if gc_was_enabled:
            gc.enable()
    gc.collect()

    assert all(provider_ref() is None for provider_ref in provider_refs)
    assert set(provider_base._PROVIDER_STATES) == original_state_keys


def test_provider_is_one_exact_concrete_handle_composed_with_adapter(tmp_path):
    checked_requests = []

    def complete_adapter(request):
        checked_requests.append(request)
        return LLMResponse(text='{"ok": true}')

    def list_models_adapter(request):
        checked_requests.append(request)
        return ["models/test"]

    provider = LLMProvider(
        gateway=TransmissionGateway(
            tmp_path / "audit.log", set, "test-provider"
        ),
        complete_adapter=complete_adapter,
        list_models_adapter=list_models_adapter,
    )

    response = provider.complete(
        LLMRequest(
            system="시스템 지시",
            user_text="사용자 입력",
            images=[b"image"],
            max_output_tokens=123,
            json_output=True,
        )
    )
    models = provider.list_models()

    assert type(provider) is LLMProvider
    assert response.text == '{"ok": true}'
    assert models == ["models/test"]
    complete_request = checked_requests[0]
    assert type(complete_request) is LLMOutboundRequest
    assert isinstance(complete_request, OutboundRequest)
    assert complete_request.text_parts == ("시스템 지시", "사용자 입력")
    assert complete_request.image_parts == (b"image",)
    assert complete_request.max_output_tokens == 123
    assert complete_request.json_output is True
    assert checked_requests[1].purpose == "list_models"


def test_provider_rejects_reinitialization_and_keeps_original_composition(tmp_path):
    original_adapter = FakeLLMAdapter(responses=["original"])
    replacement_adapter = FakeLLMAdapter(responses=["replacement"])
    original_audit = tmp_path / "original-audit.log"
    replacement_audit = tmp_path / "replacement-audit.log"
    provider = LLMProvider(
        TransmissionGateway(original_audit, set, "test-provider"),
        original_adapter.complete,
        original_adapter.list_models,
    )

    with pytest.raises(TypeError, match="이미 초기화"):
        LLMProvider.__init__(provider, object(), object(), object())

    with pytest.raises(TypeError, match="이미 초기화"):
        LLMProvider.__init__(
            provider,
            TransmissionGateway(
                replacement_audit, set, "test-provider"
            ),
            replacement_adapter.complete,
            replacement_adapter.list_models,
        )

    response = provider.complete(LLMRequest(system="safe", user_text="safe"))
    assert response.text == "original"
    assert len(original_adapter.requests) == 1
    assert replacement_adapter.requests == []
    assert original_audit.exists()
    assert not replacement_audit.exists()


def test_two_threads_cannot_initialize_the_same_provider_handle(tmp_path):
    provider = object.__new__(LLMProvider)
    adapters = [
        FakeLLMAdapter(responses=["first"]),
        FakeLLMAdapter(responses=["second"]),
    ]
    workers_ready = Barrier(2)

    def initialize(index):
        workers_ready.wait()
        try:
            LLMProvider.__init__(
                provider,
                TransmissionGateway(
                    tmp_path / f"concurrent-{index}.log",
                    set,
                    "test-provider",
                ),
                adapters[index].complete,
                adapters[index].list_models,
            )
        except TypeError as error:
            return str(error)
        return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(initialize, range(2)))

    assert results.count(None) == 1
    assert sum("이미 초기화" in result for result in results if result) == 1
    assert provider.complete(LLMRequest(system="safe", user_text="safe")).text in {
        "first",
        "second",
    }
    assert sum(len(adapter.requests) for adapter in adapters) == 1


def test_provider_init_rejects_equal_hash_foreign_object_without_pollution(
    tmp_path,
):
    original_adapter = FakeLLMAdapter(responses=["original"])
    replacement_adapter = FakeLLMAdapter(responses=["replacement"])
    provider = LLMProvider(
        TransmissionGateway(tmp_path / "original.log", set, "test-provider"),
        original_adapter.complete,
        original_adapter.list_models,
    )

    class EqualHashForeign:
        __slots__ = ("__weakref__",)

        def __hash__(self):
            return hash(provider)

        def __eq__(self, _other):
            return True

    foreign = EqualHashForeign()
    original_state_keys = set(provider_base._PROVIDER_STATES)
    with pytest.raises(TypeError, match="정확한 언어 모형 제공자"):
        LLMProvider.__init__(foreign, object(), object(), object())

    with pytest.raises(TypeError, match="정확한 언어 모형 제공자"):
        LLMProvider.__init__(
            foreign,
            TransmissionGateway(
                tmp_path / "replacement.log", set, "test-provider"
            ),
            replacement_adapter.complete,
            replacement_adapter.list_models,
        )

    response = provider.complete(LLMRequest(system="safe", user_text="safe"))
    assert response.text == "original"
    assert replacement_adapter.requests == []
    assert set(provider_base._PROVIDER_STATES) == original_state_keys


def test_provider_states_are_isolated_from_equal_hash_semantics(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(LLMProvider, "__hash__", lambda _self: 1)
    monkeypatch.setattr(LLMProvider, "__eq__", lambda _self, _other: True)
    first_adapter = FakeLLMAdapter(responses=["first"])
    second_adapter = FakeLLMAdapter(responses=["second"])
    first = LLMProvider(
        TransmissionGateway(tmp_path / "first.log", set, "test-provider"),
        first_adapter.complete,
        first_adapter.list_models,
    )
    second = LLMProvider(
        TransmissionGateway(tmp_path / "second.log", set, "test-provider"),
        second_adapter.complete,
        second_adapter.list_models,
    )

    assert first.complete(LLMRequest(system="safe", user_text="first")).text == "first"
    assert second.complete(LLMRequest(system="safe", user_text="second")).text == "second"


def test_late_cleanup_from_collected_owner_keeps_reused_identity_entry(
    monkeypatch,
):
    first, _first_adapter = make_fake_llm_provider(responses=[])
    second, _second_adapter = make_fake_llm_provider(responses=[])

    assert all(type(key) is int for key in provider_base._PROVIDER_STATES)
    first_identity = id(first)
    first_entry = provider_base._PROVIDER_STATES[first_identity]
    second_identity = id(second)
    second_entry = provider_base._PROVIDER_STATES[second_identity]
    pending_cleanups = []
    real_cleanup = provider_base._cleanup_provider_state
    monkeypatch.setattr(
        provider_base,
        "_cleanup_provider_state",
        lambda identity, dead_ref: pending_cleanups.append((identity, dead_ref)),
    )
    first_ref = ref(first)
    del first
    gc.collect()

    assert first_ref() is None
    matching_cleanups = [
        cleanup
        for cleanup in pending_cleanups
        if cleanup[0] == first_identity
        and cleanup[1] is first_entry.handle_ref
    ]
    assert len(matching_cleanups) == 1
    cleanup_identity, dead_ref = matching_cleanups[0]
    assert cleanup_identity == first_identity
    assert dead_ref is first_entry.handle_ref
    for pending_cleanup in pending_cleanups:
        if not (
            pending_cleanup[0] == cleanup_identity
            and pending_cleanup[1] is dead_ref
        ):
            real_cleanup(*pending_cleanup)

    provider_base._PROVIDER_STATES[first_identity] = second_entry
    try:
        real_cleanup(cleanup_identity, dead_ref)
        assert provider_base._PROVIDER_STATES[first_identity] is second_entry
    finally:
        if provider_base._PROVIDER_STATES.get(first_identity) is second_entry:
            del provider_base._PROVIDER_STATES[first_identity]

    assert provider_base._PROVIDER_STATES[second_identity] is second_entry


@pytest.mark.parametrize("method_name", ["complete", "list_models"])
def test_provider_slots_prevent_public_method_shadow(method_name):
    provider, _adapter = make_fake_llm_provider(responses=[])

    with pytest.raises(AttributeError, match=method_name):
        setattr(provider, method_name, lambda *args: None)

    assert not hasattr(provider, "__dict__")


@pytest.mark.parametrize(
    "attribute_name",
    ["_gateway", "_complete_adapter", "_list_models_adapter"],
)
@pytest.mark.parametrize("setter", [setattr, object.__setattr__])
def test_provider_composition_cannot_be_rebound_after_creation(
    attribute_name, setter
):
    provider, _adapter = make_fake_llm_provider(responses=[])

    with pytest.raises(AttributeError, match=attribute_name):
        setter(provider, attribute_name, object())


def test_provider_rejects_private_state_slot_replacement():
    provider, original_adapter = make_fake_llm_provider(responses=["original"])
    replacement, replacement_adapter = make_fake_llm_provider(
        responses=["replacement"]
    )
    original_state = object.__getattribute__(provider, "_LLMProvider__state")
    replacement_state = object.__getattribute__(
        replacement, "_LLMProvider__state"
    )

    object.__setattr__(provider, "_LLMProvider__state", replacement_state)
    try:
        with pytest.raises(TypeError, match="초기화된 언어 모형 제공자"):
            provider.complete(LLMRequest(system="safe", user_text="safe"))
    finally:
        object.__setattr__(provider, "_LLMProvider__state", original_state)

    assert original_adapter.requests == []
    assert replacement_adapter.requests == []


@pytest.mark.parametrize(
    ("field_name", "bad_value"),
    [
        ("max_output_tokens", 0),
        ("max_output_tokens", -1),
        ("max_output_tokens", True),
        ("max_output_tokens", "secret-output-setting"),
        ("json_output", 1),
        ("json_output", "secret-output-setting"),
    ],
)
def test_invalid_output_settings_are_rejected_before_audit_or_adapter(
    tmp_path, field_name, bad_value
):
    audit_path = tmp_path / "audit.log"
    provider, adapter = make_fake_llm_provider(
        responses=["unused"],
        gateway=TransmissionGateway(audit_path, set, "test-provider"),
    )
    request = LLMRequest(system="safe", user_text="safe")
    setattr(request, field_name, bad_value)

    with pytest.raises(ValueError, match="출력"):
        provider.complete(request)

    assert adapter.requests == []
    assert not audit_path.exists()


def test_provider_subclass_is_unsupported_but_escaped_class_still_fails_exact_guard(
    tmp_path,
):
    escaped_types = []

    class CaptureOwner:
        def __set_name__(self, owner, name):
            escaped_types.append(owner)

    with pytest.raises(TypeError, match="하위 자료형"):

        class EscapedProvider(LLMProvider):
            capture = CaptureOwner()

    adapter = FakeLLMAdapter(responses=["unguarded"])
    provider = object.__new__(escaped_types[0])
    original_state_keys = set(provider_base._PROVIDER_STATES)

    with pytest.raises(TypeError, match="정확한 언어 모형 제공자"):
        LLMProvider.__init__(
            provider,
            TransmissionGateway(tmp_path / "audit.log", set, "test-provider"),
            adapter.complete,
            adapter.list_models,
        )

    with pytest.raises(TypeError, match="정확한 언어 모형 제공자"):
        LLMProvider.complete(
            provider,
            LLMRequest(system="안전한 지시", user_text="사용자 입력"),
        )

    assert adapter.requests == []
    assert not (tmp_path / "audit.log").exists()
    assert set(provider_base._PROVIDER_STATES) == original_state_keys


def test_provider_rejects_transmission_gateway_subclass(tmp_path):
    calls = []
    audit_path = tmp_path / "audit.log"

    class BypassGateway(TransmissionGateway):
        def send(self, request, callback):
            calls.append(request)
            return callback(request)

    gateway = BypassGateway(audit_path, set, "test-provider")
    adapter = FakeLLMAdapter(responses=["unguarded"])

    with pytest.raises(TypeError, match="정확한 전송 게이트웨이"):
        LLMProvider(gateway, adapter.complete, adapter.list_models)

    assert calls == []
    assert not audit_path.exists()


def test_transmission_gateway_instance_send_cannot_be_replaced(tmp_path):
    gateway = TransmissionGateway(tmp_path / "audit.log", set, "test-provider")

    with pytest.raises(AttributeError):
        gateway.send = lambda request, callback: callback(request)


def test_provider_completion_cannot_bypass_pii_check(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(
        audit_path,
        pii_terms_provider=lambda: {"김미래"},
        provider="test-provider",
    )
    provider, adapter = make_fake_llm_provider(
        responses=["should not be returned"], gateway=gateway
    )

    with pytest.raises(PIIViolation):
        provider.complete(
            LLMRequest(system="안전한 지시", user_text="김미래", images=[])
        )

    assert adapter.requests == []
    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["provider"] == "test-provider"
    assert entry["purpose"] == "rubric_compile"
    assert entry["pii_check"] == "blocked"


def test_fake_adapter_returns_queued_response_and_records_requests():
    provider, adapter = make_fake_llm_provider(responses=["a", "b"])

    first = provider.complete(
        LLMRequest(system="s", user_text="첫 번째", images=[])
    )
    second = provider.complete(
        LLMRequest(system="s", user_text="두 번째", images=[])
    )

    assert isinstance(adapter, FakeLLMAdapter)
    assert first.text == "a"
    assert second.text == "b"
    assert [request.user_text for request in adapter.requests] == [
        "첫 번째",
        "두 번째",
    ]


def test_fake_adapter_lists_models_through_exact_provider():
    provider, _adapter = make_fake_llm_provider(
        responses=[], models=["gemini-a", "gemini-b"]
    )

    assert type(provider) is LLMProvider
    assert provider.list_models() == ["gemini-a", "gemini-b"]


def test_gemini_model_list_uses_gateway_and_safe_audit(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(audit_path, set, "test-provider")
    models = SimpleNamespace(
        list=lambda: [
            genai_types.Model(
                name="models/gemini-b",
                supported_actions=["generateContent"],
                output_token_limit=64000,
            ),
            genai_types.Model(
                name="models/actions-unknown",
                supported_actions=[],
                output_token_limit=64000,
            ),
            genai_types.Model(
                name="models/actions-absent",
                output_token_limit=64000,
            ),
            genai_types.Model(
                name="models/not-for-generation",
                supported_actions=["embedContent"],
                output_token_limit=64000,
            ),
            genai_types.Model(
                name="models/output-limit-unknown",
                supported_actions=["generateContent"],
            ),
            genai_types.Model(
                name="models/output-limit-too-small",
                supported_actions=["generateContent"],
                output_token_limit=31999,
            ),
            genai_types.Model(
                name="models/gemini-a",
                supported_actions=["generateContent"],
                output_token_limit=32000,
            ),
        ]
    )
    provider = create_gemini_provider(
        api_key="api-key-secret",
        model=None,
        gateway=gateway,
        client=SimpleNamespace(models=models),
    )

    assert type(provider) is LLMProvider
    assert provider.list_models() == ["models/gemini-a", "models/gemini-b"]

    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["provider"] == "test-provider"
    assert entry["purpose"] == "list_models"
    assert entry["payload_bytes"] == 0
    assert "api-key-secret" not in audit_path.read_text(encoding="utf-8")


def test_application_provider_factory_returns_exact_handle_and_audits_as_gemini(
    monkeypatch,
):
    client = SimpleNamespace(models=SimpleNamespace(list=lambda: []))
    monkeypatch.setattr(gemini_llm.genai, "Client", lambda api_key: client)

    provider = build_provider("api-key-secret", None)

    assert type(provider) is LLMProvider
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
    provider = create_gemini_provider(
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
