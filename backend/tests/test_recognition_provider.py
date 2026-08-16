import json

from app.providers.gemini_recognition import GeminiRecognitionProvider
from app.providers.gateway import TransmissionGateway
from app.providers.recognition import (
    build_classify_prompt,
    parse_classify_output,
    parse_transcribe_output,
)
from app.schemas.recognition import RecognitionStatus
from tests.fakes import FakeRecognitionProvider, make_fake_llm_provider


def test_prompt_lists_all_candidates():
    prompt = build_classify_prompt(["10,000", "6,000", "4,000"], slot_count=1)
    for candidate in ("10,000", "6,000", "4,000"):
        assert candidate in prompt


def test_prompt_includes_escape_hatches_and_slot_count():
    prompt = build_classify_prompt(["가", "나"], slot_count=3)
    assert "없음" in prompt
    assert "판독" in prompt
    assert "3" in prompt


def test_prompt_rejects_invalid_candidates_and_slot_count():
    for candidates, slot_count in [([], 1), ([""], 1), (["가", "가"], 1), (["가"], 0)]:
        try:
            build_classify_prompt(candidates, slot_count)
        except ValueError:
            pass
        else:
            raise AssertionError("잘못된 후보 입력을 받아들였습니다.")


def test_parse_ok_output():
    raw = json.dumps({"values": ["10,000"], "confidence": 0.93}, ensure_ascii=False)
    result = parse_classify_output(
        raw,
        slot_count=1,
        candidates=["10,000", "6,000"],
    )
    assert result.status == RecognitionStatus.OK
    assert result.values == ["10,000"]
    assert result.confidence == 0.93


def test_parse_rejects_value_outside_candidates():
    raw = json.dumps({"values": ["새 값"], "confidence": 0.93}, ensure_ascii=False)
    result = parse_classify_output(raw, 1, candidates=["10,000"])
    assert result.status == RecognitionStatus.ERROR
    assert result.values == []


def test_parse_none_of_above():
    raw = json.dumps({"values": [], "status": "none_of_above", "confidence": 0.8})
    result = parse_classify_output(raw, slot_count=1)
    assert result.status == RecognitionStatus.NONE_OF_ABOVE


def test_parse_unreadable():
    raw = json.dumps({"values": [], "status": "unreadable", "confidence": 0.0})
    result = parse_classify_output(raw, slot_count=1)
    assert result.status == RecognitionStatus.UNREADABLE


def test_parse_malformed_json_returns_fixed_error_status():
    result = parse_classify_output("JSON 아님", slot_count=1)
    assert result.status == RecognitionStatus.ERROR
    assert result.note == "분류 응답 형식이 올바르지 않습니다."


def test_parse_wrong_slot_count_is_error_without_values():
    raw = json.dumps({"values": ["가"], "confidence": 0.9})
    result = parse_classify_output(raw, slot_count=2)
    assert result.status == RecognitionStatus.ERROR
    assert result.values == []
    assert "개수" in result.note


def test_parse_invalid_confidence_is_error_not_clamped():
    raw = json.dumps({"values": ["가"], "confidence": 1.4})
    result = parse_classify_output(raw, slot_count=1)
    assert result.status == RecognitionStatus.ERROR
    assert result.confidence == 0.0


def test_parse_transcription_contract():
    raw = json.dumps({"text": "계산 과정", "confidence": 0.84}, ensure_ascii=False)
    result = parse_transcribe_output(raw)
    assert result.status == RecognitionStatus.OK
    assert result.text == "계산 과정"


def test_parse_transcription_rejects_non_string_text():
    raw = json.dumps({"text": {"secret": "값"}, "confidence": 0.84}, ensure_ascii=False)
    result = parse_transcribe_output(raw)
    assert result.status == RecognitionStatus.ERROR
    assert result.text == ""


def test_fake_provider_returns_queued_results():
    provider = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]],
        transcribe_results=["계산 과정"],
    )
    classified = provider.classify(b"png", ["선대칭"], slot_count=2)
    assert classified.values == ["선대칭", "점대칭"]
    transcribed = provider.transcribe(b"png")
    assert transcribed.text == "계산 과정"


def test_gemini_recognition_uses_exact_handle_once_and_audits_token(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(
        audit_log_path=audit_path,
        pii_terms_provider=set,
        provider="test-provider",
    )
    llm, adapter = make_fake_llm_provider(
        responses=[json.dumps({"values": ["가"], "confidence": 0.95}, ensure_ascii=False)],
        gateway=gateway,
    )
    recognizer = GeminiRecognitionProvider(llm=llm)
    result = recognizer.classify(
        b"png",
        ["가", "나"],
        anonymous_token="S-abcd1234",
    )
    assert result.values == ["가"]
    assert adapter.requests[0].images == [b"png"]
    entries = [json.loads(line) for line in audit_path.read_text().splitlines()]
    assert len(entries) == 1
    assert entries[0]["purpose"] == "recognize_classify"
    assert entries[0]["anonymous_token"] == "S-abcd1234"


def test_missing_token_fails_before_external_call():
    llm, adapter = make_fake_llm_provider(
        responses=[json.dumps({"values": ["가"], "confidence": 0.95}, ensure_ascii=False)]
    )
    recognizer = GeminiRecognitionProvider(llm=llm)
    result = recognizer.classify(b"png", ["가"])
    assert result.status == RecognitionStatus.ERROR
    assert adapter.requests == []


def test_provider_failure_does_not_copy_exception_details():
    llm, _ = make_fake_llm_provider(responses=[RuntimeError("/비밀/경로")])
    recognizer = GeminiRecognitionProvider(llm=llm)
    result = recognizer.transcribe(b"png", anonymous_token="S-abcd1234")
    assert result.status == RecognitionStatus.ERROR
    assert result.note == "전사 외부 호출에 실패했습니다."
    assert "비밀" not in result.note
