import json

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
        text_parts=["김미래 학생의 답: 25%"],
        image_parts=[],
    )

    with pytest.raises(PIIViolation) as exc:
        gateway.send(request, lambda req: "ok")

    assert "김미래" in str(exc.value)


def test_blocked_request_does_not_invoke_provider(gateway):
    calls = []
    request = OutboundRequest(
        purpose="grade_open_text", text_parts=["박균형"], image_parts=[]
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
    request = OutboundRequest(purpose="x", text_parts=["김미래"], image_parts=[])

    with pytest.raises(PIIViolation):
        gateway.send(request, lambda req: "ok")

    entry = json.loads((tmp_path / "audit.log").read_text().splitlines()[0])
    assert entry["pii_check"] == "blocked"


def test_audit_log_never_stores_payload_or_extra_metadata(gateway, tmp_path):
    request = OutboundRequest(
        purpose="rubric_compile",
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
