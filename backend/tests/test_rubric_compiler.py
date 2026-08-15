import json
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.providers.base import LLMResponse
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import GeminiLLMProvider
from app.services.pdf_extract import PdfExtract, PdfPage
from app.services.rubric_compiler import (
    CompileResult,
    RubricCompileAuthority,
    compile_rubric,
)
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


@pytest.fixture
def authority():
    return RubricCompileAuthority(
        assessment={
            "title": "교사 평가명",
            "subject": "교사 과목",
            "grade": 6,
            "total_points": 4,
        },
        achievement_standards=[
            {
                "id": "AS1",
                "item_range": [1, 2],
                "core_standard": "교사 성취기준",
                "levels": {"1": "교사 일수준", "2": "교사 이수준", "3": "교사 삼수준"},
            }
        ],
        level_cutoffs={"3": 4, "2": 2, "1": 0},
    )


def _payload(rubric: dict = VALID_RUBRIC) -> str:
    return json.dumps(rubric, ensure_ascii=False)


def _with_wrong_points() -> dict:
    broken = json.loads(_payload())
    broken["items"][0]["points"] = 99
    return broken


def test_authority_is_a_deeply_immutable_snapshot():
    assessment = {
        "title": "교사 평가명",
        "subject": "수학",
        "grade": 6,
        "total_points": 4,
    }
    standards = [
        {
            "id": "AS1",
            "item_range": [1, 2],
            "core_standard": "교사 성취기준",
            "levels": {"1": "교사 일수준"},
        }
    ]
    cutoffs = {"3": 4, "1": 0}
    authority = RubricCompileAuthority(
        assessment=assessment,
        achievement_standards=standards,
        level_cutoffs=cutoffs,
    )

    assessment["title"] = "바뀐 평가명"
    standards[0]["levels"]["1"] = "바뀐 수준"
    cutoffs["3"] = 999
    returned_assessment = authority.assessment
    returned_assessment.title = "반환값 바꾸기"
    returned_standard = authority.achievement_standards[0]
    returned_standard.levels["1"] = "반환값 바꾸기"
    returned_cutoffs = authority.level_cutoffs
    returned_cutoffs["3"] = 999

    assert authority.assessment.title == "교사 평가명"
    assert authority.achievement_standards[0].levels == {"1": "교사 일수준"}
    assert authority.level_cutoffs == {"3": 4, "1": 0}
    with pytest.raises(FrozenInstanceError):
        authority._snapshot_json = "{}"


def test_authority_can_be_built_directly_from_assessment_record():
    record = SimpleNamespace(
        title="행 평가명",
        subject="수학",
        grade=6,
        total_points=4,
        achievement_standards=[
            {
                "id": "AS1",
                "item_range": [1, 2],
                "core_standard": "행 성취기준",
                "levels": {"1": "기초"},
            }
        ],
        level_cutoffs={"3": 4, "1": 0},
    )

    authority = RubricCompileAuthority.from_assessment(record)

    assert authority.assessment.title == "행 평가명"
    assert authority.achievement_standards[0].core_standard == "행 성취기준"
    assert authority.level_cutoffs == {"3": 4, "1": 0}


def test_invalid_authority_cutoffs_are_rejected_before_audit_or_provider_call(
    tmp_path,
):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(audit_path, set, "test-provider")
    provider = FakeLLMProvider(responses=[_payload()], gateway=gateway)

    with pytest.raises(ValueError, match="총점 범위를 벗어납니다"):
        RubricCompileAuthority(
            assessment={
                "title": "교사 평가명",
                "subject": "수학",
                "grade": 6,
                "total_points": 4,
            },
            achievement_standards=[],
            level_cutoffs={"3": 5, "1": 0},
        )

    assert provider.requests == []
    assert not audit_path.exists()


def test_all_teacher_authority_fields_override_model_without_retry(extracts, authority):
    changed = json.loads(_payload())
    changed["assessment"] = {
        "title": "모형 평가명",
        "subject": "모형 과목",
        "grade": 99,
        "total_points": 999,
    }
    changed["achievement_standards"] = [
        {
            "id": "MODEL",
            "item_range": [99, 100],
            "core_standard": "모형 성취기준",
            "levels": {"1": "모형 수준"},
        }
    ]
    changed["level_cutoffs"] = {"3": 999, "1": 998}
    provider = FakeLLMProvider(responses=[_payload(changed)])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.attempts == 1
    assert len(provider.requests) == 1
    assert result.rubric is not None
    assert result.rubric.assessment.model_dump() == {
        "title": "교사 평가명",
        "subject": "교사 과목",
        "grade": 6,
        "total_points": 4,
    }
    assert [standard.model_dump() for standard in result.rubric.achievement_standards] == [
        {
            "id": "AS1",
            "item_range": [1, 2],
            "core_standard": "교사 성취기준",
            "levels": {"1": "교사 일수준", "2": "교사 이수준", "3": "교사 삼수준"},
        }
    ]
    assert result.rubric.level_cutoffs == {"3": 4, "2": 2, "1": 0}
    assert "교사 평가명" in provider.requests[0].user_text
    assert "교사 성취기준" in provider.requests[0].user_text
    assert '"3": 4' in provider.requests[0].user_text


def test_malformed_model_values_in_protected_fields_do_not_trigger_retry(
    extracts, authority
):
    changed = json.loads(_payload())
    changed["assessment"] = {"title": ["잘못된 모양"]}
    changed["achievement_standards"] = "잘못된 모양"
    changed["level_cutoffs"] = {"3": "잘못된 값"}
    provider = FakeLLMProvider(responses=[_payload(changed)])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.attempts == 1
    assert len(provider.requests) == 1
    assert result.rubric is not None
    assert result.rubric.assessment.title == "교사 평가명"
    assert result.rubric.achievement_standards[0].core_standard == "교사 성취기준"
    assert result.rubric.level_cutoffs == {"3": 4, "2": 2, "1": 0}


def test_rejects_provider_that_does_not_own_a_transmission_gateway(
    extracts, authority
):
    class BypassProvider:
        def complete(self, _request):
            return LLMResponse(text=_payload())

    with pytest.raises(TypeError, match="전송 게이트웨이"):
        compile_rubric(BypassProvider(), extracts, authority)


def test_compiles_valid_rubric(extracts, authority):
    provider = FakeLLMProvider(responses=[_payload()])

    result = compile_rubric(provider, extracts, authority)

    assert isinstance(result, CompileResult)
    assert result.succeeded
    assert result.attempts == 1
    assert result.rubric is not None
    assert len(result.rubric.items) == 2
    assert result.rubric.items[0].blanks[0].answers == ["선대칭"]
    assert result.errors == []


def test_strips_one_outer_markdown_code_fence(extracts, authority):
    fenced = "```json\n" + _payload() + "\n```"
    provider = FakeLLMProvider(responses=[fenced])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.attempts == 1


def test_teacher_total_points_overrides_model_value(extracts, authority):
    wrong_model_total = json.loads(_payload())
    wrong_model_total["assessment"]["total_points"] = 999
    provider = FakeLLMProvider(responses=[_payload(wrong_model_total)])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.rubric is not None
    assert result.rubric.assessment.total_points == 4
    assert result.attempts == 1


def test_retries_once_with_business_validation_feedback(extracts, authority):
    provider = FakeLLMProvider(responses=[_payload(_with_wrong_points()), _payload()])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.attempts == 2
    assert len(provider.requests) == 2
    assert "배점 합계" not in provider.requests[0].user_text
    assert "배점 합계" in provider.requests[1].user_text
    assert "채점기준표 내용" in provider.requests[1].user_text
    assert provider.requests[0].images == [b"\x89PNG fake"]
    assert provider.requests[1].images == [b"\x89PNG fake"]
    assert all(request.purpose == "rubric_compile" for request in provider.requests)


def test_retries_once_with_schema_validation_feedback(extracts, authority):
    broken = json.loads(_payload())
    del broken["items"][0]["title"]
    provider = FakeLLMProvider(responses=[_payload(broken), _payload()])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.attempts == 2
    assert "items.0.title" in provider.requests[1].user_text


def test_gives_up_after_second_validation_failure(extracts, authority):
    payload = _payload(_with_wrong_points())
    provider = FakeLLMProvider(responses=[payload, payload, _payload()])

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.attempts == 2
    assert any("배점 합계" in error for error in result.errors)
    assert len(provider.requests) == 2


def test_malformed_json_is_reported_without_response_body(extracts, authority):
    secret_response = "원문-비밀-응답"
    provider = FakeLLMProvider(responses=[secret_response, secret_response])

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.attempts == 2
    assert any("JSON" in error for error in result.errors)
    assert secret_response not in " ".join(result.errors)


def test_warnings_are_returned_alongside_rubric(extracts, authority):
    provider = FakeLLMProvider(responses=[_payload()])

    result = compile_rubric(provider, extracts, authority)

    assert any(warning.code == "manual_review_required" for warning in result.warnings)


def test_warnings_from_last_structured_failure_are_preserved(extracts, authority):
    broken = _with_wrong_points()
    broken["items"][0]["title"] = "㉠을 고르기"
    payload = _payload(broken)
    provider = FakeLLMProvider(responses=[payload, payload])

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)


def test_last_structured_rubric_survives_malformed_second_response(
    extracts, authority
):
    broken = _with_wrong_points()
    broken["items"][0]["title"] = "㉠을 고르기"
    provider = FakeLLMProvider(responses=[_payload(broken), "읽을 수 없는 둘째 응답"])

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)
    assert any("JSON" in error for error in result.errors)


def test_last_structured_rubric_survives_second_provider_failure(
    extracts, authority
):
    broken = _with_wrong_points()
    broken["items"][0]["title"] = "㉠을 고르기"
    provider = FakeLLMProvider(
        responses=[_payload(broken), RuntimeError("provider-secret")]
    )

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.attempts == 2
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)
    assert result.errors == ["언어 모형 제공자 호출에 실패했습니다."]


def test_symbol_family_mismatch_is_not_corrected(extracts, authority):
    mismatched = json.loads(_payload())
    mismatched["items"][0]["title"] = "㉠을 고르기"
    provider = FakeLLMProvider(responses=[_payload(mismatched)])

    result = compile_rubric(provider, extracts, authority)

    assert result.succeeded
    assert result.rubric is not None
    assert result.rubric.items[0].title == "㉠을 고르기"
    assert result.rubric.items[0].blanks[0].key == "①"
    assert any(warning.code == "symbol_family_mismatch" for warning in result.warnings)


def test_all_page_images_are_sent_in_document_and_page_order(authority):
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

    compile_rubric(provider, extracts, authority)

    assert provider.requests[0].images == [b"first-1", b"first-2", b"second-1"]
    assert "첫 쪽" in provider.requests[0].user_text
    assert "둘째 쪽" in provider.requests[0].user_text
    assert "셋째 쪽" in provider.requests[0].user_text
    assert "first.pdf" not in provider.requests[0].user_text


def test_gemini_completion_uses_provider_gateway_and_safe_audit(
    tmp_path, extracts, authority
):
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

    result = compile_rubric(provider, extracts, authority)

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


def test_provider_error_is_sanitized_and_not_retried(
    tmp_path, extracts, authority
):
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

    result = compile_rubric(provider, extracts, authority)

    assert not result.succeeded
    assert result.attempts == 1
    assert result.errors == ["언어 모형 제공자 호출에 실패했습니다."]
    assert "provider-secret" not in audit_path.read_text()
    assert "api-key-secret" not in audit_path.read_text()
