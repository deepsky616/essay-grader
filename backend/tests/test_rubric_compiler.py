import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.providers.base import LLMResponse
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import GeminiLLMProvider
from app.services.pdf_extract import PdfExtract, PdfPage
from app.services.rubric_compiler import CompileResult, compile_rubric
from tests.fakes import FakeLLMProvider


VALID_RUBRIC = {
    "assessment": {
        "title": "수학 논술형",
        "subject": "수학",
        "grade": 6,
        "total_points": 4,
    },
    "achievement_standards": [
        {
            "id": "AS1",
            "item_range": [1, 2],
            "core_standard": "선대칭과 점대칭을 이해한다.",
            "levels": {"1": "시도", "2": "가능", "3": "정확"},
        }
    ],
    "items": [
        {
            "item_no": 1,
            "title": "대칭축 찾기",
            "points": 2,
            "standard_id": "AS1",
            "type": "closed_short",
            "blanks": [
                {"key": "①", "answers": ["선대칭"], "aliases": ["선 대칭"]},
                {"key": "②", "answers": ["점대칭"], "aliases": []},
            ],
            "scoring": [
                {"score": 2, "condition": "all_correct", "criterion": "둘 다 정확"},
                {"score": 1, "condition": "partial:1", "criterion": "하나만"},
                {"score": 0, "condition": "none_correct", "criterion": "모두 틀림"},
            ],
            "example_answer": "① 선대칭 ② 점대칭",
        },
        {
            "item_no": 2,
            "title": "점대칭 도형 그리기",
            "points": 2,
            "standard_id": "AS1",
            "type": "drawing",
            "scoring": [
                {"score": 2, "condition": "manual", "criterion": "정확하게 완성"},
                {"score": 0, "condition": "manual", "criterion": "그리지 못함"},
            ],
            "example_answer": "예시 그림 참조",
        },
    ],
    "level_cutoffs": {"3": 4, "2": 2, "1": 0},
}


@pytest.fixture
def extracts():
    page = PdfPage(page_no=1, text="채점기준표 내용", image_png=b"\x89PNG fake")
    return [PdfExtract(source_path=Path("rubric.pdf"), pages=[page])]


def _payload(rubric: dict = VALID_RUBRIC) -> str:
    return json.dumps(rubric, ensure_ascii=False)


def _with_wrong_points() -> dict:
    broken = json.loads(_payload())
    broken["items"][0]["points"] = 99
    return broken


def test_compiles_valid_rubric(extracts):
    provider = FakeLLMProvider(responses=[_payload()])

    result = compile_rubric(provider, extracts, total_points=4)

    assert isinstance(result, CompileResult)
    assert result.succeeded
    assert result.attempts == 1
    assert result.rubric is not None
    assert len(result.rubric.items) == 2
    assert result.rubric.items[0].blanks[0].answers == ["선대칭"]
    assert result.errors == []


def test_strips_one_outer_markdown_code_fence(extracts):
    fenced = "```json\n" + _payload() + "\n```"
    provider = FakeLLMProvider(responses=[fenced])

    result = compile_rubric(provider, extracts, total_points=4)

    assert result.succeeded
    assert result.attempts == 1


def test_teacher_total_points_overrides_model_value(extracts):
    wrong_model_total = json.loads(_payload())
    wrong_model_total["assessment"]["total_points"] = 999
    provider = FakeLLMProvider(responses=[_payload(wrong_model_total)])

    result = compile_rubric(provider, extracts, total_points=4)

    assert result.succeeded
    assert result.rubric is not None
    assert result.rubric.assessment.total_points == 4
    assert result.attempts == 1


def test_retries_once_with_business_validation_feedback(extracts):
    provider = FakeLLMProvider(responses=[_payload(_with_wrong_points()), _payload()])

    result = compile_rubric(provider, extracts, total_points=4)

    assert result.succeeded
    assert result.attempts == 2
    assert len(provider.requests) == 2
    assert "배점 합계" not in provider.requests[0].user_text
    assert "배점 합계" in provider.requests[1].user_text
    assert "채점기준표 내용" in provider.requests[1].user_text
    assert provider.requests[0].images == [b"\x89PNG fake"]
    assert provider.requests[1].images == [b"\x89PNG fake"]
    assert all(request.purpose == "rubric_compile" for request in provider.requests)


def test_retries_once_with_schema_validation_feedback(extracts):
    broken = json.loads(_payload())
    del broken["assessment"]["subject"]
    provider = FakeLLMProvider(responses=[_payload(broken), _payload()])

    result = compile_rubric(provider, extracts, total_points=4)

    assert result.succeeded
    assert result.attempts == 2
    assert "assessment.subject" in provider.requests[1].user_text


def test_gives_up_after_second_validation_failure(extracts):
    payload = _payload(_with_wrong_points())
    provider = FakeLLMProvider(responses=[payload, payload, _payload()])

    result = compile_rubric(provider, extracts, total_points=4)

    assert not result.succeeded
    assert result.attempts == 2
    assert any("배점 합계" in error for error in result.errors)
    assert len(provider.requests) == 2


def test_malformed_json_is_reported_without_response_body(extracts):
    secret_response = "원문-비밀-응답"
    provider = FakeLLMProvider(responses=[secret_response, secret_response])

    result = compile_rubric(provider, extracts, total_points=4)

    assert not result.succeeded
    assert result.attempts == 2
    assert any("JSON" in error for error in result.errors)
    assert secret_response not in " ".join(result.errors)


def test_warnings_are_returned_alongside_rubric(extracts):
    provider = FakeLLMProvider(responses=[_payload()])

    result = compile_rubric(provider, extracts, total_points=4)

    assert any(warning.code == "manual_review_required" for warning in result.warnings)


def test_warnings_from_last_structured_failure_are_preserved(extracts):
    broken = _with_wrong_points()
    broken["items"][0]["title"] = "㉠을 고르기"
    payload = _payload(broken)
    provider = FakeLLMProvider(responses=[payload, payload])

    result = compile_rubric(provider, extracts, total_points=4)

    assert not result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)


def test_last_structured_rubric_survives_malformed_second_response(extracts):
    broken = _with_wrong_points()
    broken["items"][0]["title"] = "㉠을 고르기"
    provider = FakeLLMProvider(responses=[_payload(broken), "읽을 수 없는 둘째 응답"])

    result = compile_rubric(provider, extracts, total_points=4)

    assert not result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)
    assert any("JSON" in error for error in result.errors)


def test_last_structured_rubric_survives_second_provider_failure(extracts):
    broken = _with_wrong_points()
    broken["items"][0]["title"] = "㉠을 고르기"

    class FailingSecondProvider(FakeLLMProvider):
        def complete(self, request):
            if self.requests:
                self.requests.append(request)
                raise RuntimeError("provider-secret")
            self.requests.append(request)
            return LLMResponse(text=_payload(broken))

    provider = FailingSecondProvider(responses=[])

    result = compile_rubric(provider, extracts, total_points=4)

    assert not result.succeeded
    assert result.attempts == 2
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)
    assert result.errors == ["언어 모형 제공자 호출에 실패했습니다."]


def test_symbol_family_mismatch_is_not_corrected(extracts):
    mismatched = json.loads(_payload())
    mismatched["items"][0]["title"] = "㉠을 고르기"
    provider = FakeLLMProvider(responses=[_payload(mismatched)])

    result = compile_rubric(provider, extracts, total_points=4)

    assert result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert result.rubric.items[0].blanks[0].key == "①"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)


def test_all_page_images_are_sent_in_document_and_page_order():
    extracts = [
        PdfExtract(
            source_path=Path("first.pdf"),
            pages=[
                PdfPage(page_no=1, text="첫 쪽", image_png=b"first-1"),
                PdfPage(page_no=2, text="둘째 쪽", image_png=b"first-2"),
            ],
        ),
        PdfExtract(
            source_path=Path("second.pdf"),
            pages=[PdfPage(page_no=1, text="셋째 쪽", image_png=b"second-1")],
        ),
    ]
    provider = FakeLLMProvider(responses=[_payload()])

    compile_rubric(provider, extracts, total_points=4)

    assert provider.requests[0].images == [b"first-1", b"first-2", b"second-1"]
    assert "첫 쪽" in provider.requests[0].user_text
    assert "둘째 쪽" in provider.requests[0].user_text
    assert "셋째 쪽" in provider.requests[0].user_text
    assert "first.pdf" not in provider.requests[0].user_text


def test_gemini_completion_uses_provider_gateway_and_safe_audit(tmp_path, extracts):
    audit_path = tmp_path / "audit.log"
    captured_requests = []

    class FakeModels:
        def generate_content(self, **arguments):
            captured_requests.append(arguments)
            return SimpleNamespace(text=_payload())

    gateway = TransmissionGateway(audit_path, set, provider="gemini")
    provider = GeminiLLMProvider(
        api_key="api-key-secret",
        model="models/gemini-test",
        gateway=gateway,
        client=SimpleNamespace(models=FakeModels()),
    )

    result = compile_rubric(provider, extracts, total_points=4)

    assert result.succeeded
    assert len(captured_requests) == 1
    entries = [json.loads(line) for line in audit_path.read_text().splitlines()]
    assert len(entries) == 1
    assert entries[0]["provider"] == "gemini"
    assert entries[0]["purpose"] == "rubric_compile"
    assert entries[0]["pii_check"] == "pass"
    audit_text = audit_path.read_text()
    assert "채점기준표 내용" not in audit_text
    assert "둘 다 정확" not in audit_text
    assert "api-key-secret" not in audit_text


def test_provider_error_is_sanitized_and_not_retried(tmp_path, extracts):
    audit_path = tmp_path / "audit.log"

    class FailingModels:
        def generate_content(self, **_arguments):
            raise RuntimeError("provider-secret api-key-secret")

    gateway = TransmissionGateway(audit_path, set, provider="gemini")
    provider = GeminiLLMProvider(
        api_key="api-key-secret",
        model="models/gemini-test",
        gateway=gateway,
        client=SimpleNamespace(models=FailingModels()),
    )

    result = compile_rubric(provider, extracts, total_points=4)

    assert not result.succeeded
    assert result.attempts == 1
    assert result.errors == ["언어 모형 제공자 호출에 실패했습니다."]
    assert "provider-secret" not in audit_path.read_text()
    assert "api-key-secret" not in audit_path.read_text()
