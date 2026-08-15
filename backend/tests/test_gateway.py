import json
from dataclasses import FrozenInstanceError
from unicodedata import normalize

import pytest

from app.providers.gateway import (
    OutboundRequest,
    PIIViolation,
    TransmissionGateway,
)


@pytest.fixture
def gateway(tmp_path):
    return TransmissionGateway(
        audit_log_path=tmp_path / "audit.log",
        pii_terms_provider=lambda: {"김미래", "박균형"},
    )


def test_clean_request_passes_through(gateway):
    request = OutboundRequest(
        purpose="rubric_compile",
        text_parts=["문항 1: 선대칭 도형"],
        image_parts=[],
        provider="test-provider",
    )

    result = gateway.send(request, lambda req: "ok")

    assert result == "ok"


def test_request_containing_roster_name_is_blocked(gateway):
    request = OutboundRequest(
        purpose="grade_open_text",
        provider="test-provider",
        text_parts=["김미래 학생의 답: 25%"],
        image_parts=[],
    )

    with pytest.raises(PIIViolation) as exc:
        gateway.send(request, lambda req: "ok")

    assert "김미래" not in str(exc.value)
    assert "1건" in str(exc.value)


def test_blocked_request_does_not_invoke_provider(gateway):
    calls = []
    request = OutboundRequest(
        purpose="grade_open_text",
        provider="test-provider",
        text_parts=["박균형"],
        image_parts=[],
    )

    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: calls.append(req))

    assert calls == []


def test_audit_log_records_success(gateway, tmp_path):
    request = OutboundRequest(
        purpose="rubric_compile",
        text_parts=["안전한 내용"],
        image_parts=[b"\x89PNG fake"],
        anonymous_token="S-1a2b3c4d",
        provider="test-provider",
    )

    gateway.send(request, lambda req: "ok")

    entries = [
        json.loads(line) for line in (tmp_path / "audit.log").read_text().splitlines()
    ]
    assert len(entries) == 1
    assert entries[0]["purpose"] == "rubric_compile"
    assert entries[0]["provider"] == "test-provider"
    assert entries[0]["pii_check"] == "pass"
    assert entries[0]["anonymous_token"] == "S-1a2b3c4d"
    assert entries[0]["payload_bytes"] == len("안전한 내용".encode()) + len(b"\x89PNG fake")


def test_audit_log_records_block(gateway, tmp_path):
    request = OutboundRequest(
        purpose="x", provider="test-provider", text_parts=["김미래"], image_parts=[]
    )

    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: "ok")

    entry = json.loads((tmp_path / "audit.log").read_text().splitlines()[0])
    assert entry["pii_check"] == "blocked"


def test_audit_log_never_stores_payload_or_extra_metadata(gateway, tmp_path):
    request = OutboundRequest(
        purpose="rubric_compile",
        provider="test-provider",
        text_parts=["비밀 내용 12345", "api-key-secret"],
        image_parts=[],
    )

    gateway.send(request, lambda req: "ok")

    entry = json.loads((tmp_path / "audit.log").read_text())
    assert "비밀 내용" not in (tmp_path / "audit.log").read_text()
    assert "api-key-secret" not in (tmp_path / "audit.log").read_text()
    assert set(entry) == {
        "timestamp",
        "provider",
        "purpose",
        "anonymous_token",
        "payload_bytes",
        "pii_check",
    }


def test_request_is_immutable_after_construction_and_provider_receives_it(gateway):
    source_text = ["안전한 내용"]
    source_image = [bytearray(b"image")]
    request = OutboundRequest(
        purpose="rubric_compile",
        provider="test-provider",
        text_parts=source_text,
        image_parts=source_image,
    )
    source_text[0] = "김미래"
    source_image[0][0] = 0
    received = []

    def provider_call(checked_request):
        received.append(checked_request)
        with pytest.raises(FrozenInstanceError):
            checked_request.text_parts = ("김미래",)
        with pytest.raises(FrozenInstanceError):
            checked_request.image_parts = (b"changed",)
        return "ok"

    assert gateway.send(request, provider_call) == "ok"
    assert received == [request]
    assert received[0].text_parts == ("안전한 내용",)
    assert received[0].image_parts == (b"image",)


def test_decomposed_roster_name_is_blocked(gateway):
    request = OutboundRequest(
        purpose="grade_open_text",
        provider="test-provider",
        text_parts=[normalize("NFD", "김미래")],
    )

    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: "should not run")


def test_zero_width_character_cannot_bypass_roster_name_check(gateway):
    request = OutboundRequest(
        purpose="grade_open_text",
        provider="test-provider",
        text_parts=["김\u200b미래"],
    )

    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: "should not run")


def test_format_only_pii_term_does_not_block_every_request(tmp_path):
    gateway = TransmissionGateway(
        tmp_path / "audit.log", lambda: {"\u200b"}
    )
    request = OutboundRequest(purpose="rubric_compile", provider="test-provider")

    assert gateway.send(request, lambda req: "ok") == "ok"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("provider", ""),
        ("provider", "provider with space"),
        ("purpose", "bad/purpose"),
        ("anonymous_token", "student-1"),
        ("anonymous_token", "S-short"),
    ],
)
def test_invalid_metadata_is_not_logged_or_sent(gateway, tmp_path, field, value):
    values = {
        "purpose": "rubric_compile",
        "provider": "test-provider",
        "text_parts": ["안전한 내용"],
        "anonymous_token": "S-1a2b3c4d",
    }
    values[field] = value
    calls = []

    with pytest.raises(ValueError):
        OutboundRequest(**values)

    assert calls == []
    assert not (tmp_path / "audit.log").exists()


def test_pii_terms_provider_failure_stops_before_provider_call(tmp_path):
    def failed_terms_provider():
        raise RuntimeError("terms unavailable")

    gateway = TransmissionGateway(tmp_path / "audit.log", failed_terms_provider)
    request = OutboundRequest(purpose="rubric_compile", provider="test-provider")
    calls = []

    with pytest.raises(RuntimeError, match="terms unavailable"):
        gateway.send(request, lambda req: calls.append(req))

    assert calls == []


def test_audit_write_failure_stops_before_provider_call(gateway, monkeypatch):
    request = OutboundRequest(purpose="rubric_compile", provider="test-provider")
    calls = []

    def failed_audit(*args):
        raise OSError("audit unavailable")

    monkeypatch.setattr(gateway, "_write_audit", failed_audit)

    with pytest.raises(OSError, match="audit unavailable"):
        gateway.send(request, lambda req: calls.append(req))

    assert calls == []


def test_provider_exception_does_not_put_payload_in_audit_log(gateway, tmp_path):
    request = OutboundRequest(
        purpose="rubric_compile",
        provider="test-provider",
        text_parts=["비밀 답안 api-key-secret"],
    )

    def failed_provider(checked_request):
        raise RuntimeError("provider failed")

    with pytest.raises(RuntimeError, match="provider failed"):
        gateway.send(request, failed_provider)

    audit_text = (tmp_path / "audit.log").read_text()
    assert "비밀 답안" not in audit_text
    assert "api-key-secret" not in audit_text
