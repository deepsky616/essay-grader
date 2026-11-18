import json

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import ItemType, RubricItem, ScoringRule
from app.services.llm_grader import grade_open_text
from tests.fakes import make_fake_llm_provider


FULL_CRITERION = "가격을 바르게 계산하고 이유를 구체적으로 설명함"
PARTIAL_CRITERION = "가격은 바르게 계산했으나 의견을 제시하지 못함"
LOW_CRITERION = "판단은 했으나 계산이 틀리거나 이유를 설명하지 않음"
ZERO_CRITERION = "계산과 이유를 모두 제시하지 못함"


def _item() -> RubricItem:
    return RubricItem(
        item_no=8,
        title="백분율 의미를 해석하여 상황 설명하기",
        points=3,
        type=ItemType.OPEN_TEXT,
        scoring=[
            ScoringRule(score=3, condition="llm", criterion=FULL_CRITERION),
            ScoringRule(score=2, condition="llm", criterion=PARTIAL_CRITERION),
            ScoringRule(score=1, condition="llm", criterion=LOW_CRITERION),
            ScoringRule(score=0, condition="llm", criterion=ZERO_CRITERION),
        ],
        example_answer="16000×40/100=6400 이므로 미래의 생각은 옳지 않다.",
    )


def _response(text: str) -> RecognizedResponse:
    return RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.OK,
        text=text,
        confidence=0.8,
    )


def _llm_output(score: int, criterion: str, **overrides) -> str:
    payload = {
        "score": score,
        "matched_criterion": criterion,
        "evidence": "6400원이므로 옳지 않다",
        "reasoning": "계산이 정확하고 이유가 구체적이다",
        "confidence": 0.82,
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def test_valid_output_is_accepted_and_uses_anonymous_token():
    provider, adapter = make_fake_llm_provider(
        responses=[_llm_output(3, FULL_CRITERION)]
    )
    result = grade_open_text(
        _item(),
        _response("6400원이므로 옳지 않다"),
        provider,
        anonymous_token="S-deadbeef",
    )

    assert result.score == 3
    assert result.deferred is False
    assert result.confidence == 0.82
    assert adapter.requests[0].anonymous_token == "S-deadbeef"


def test_score_outside_rubric_is_rejected():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(5, FULL_CRITERION)]
    )
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred is True
    assert result.score is None
    assert "배점" in result.reason


def test_boolean_score_is_rejected_even_when_one_point_exists():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(True, LOW_CRITERION)]
    )
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred
    assert "배점" in result.reason


def test_criterion_not_in_rubric_is_rejected():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(3, "새로 만든 기준")]
    )
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred is True
    assert "채점기준" in result.reason


def test_score_criterion_mismatch_is_rejected():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(3, ZERO_CRITERION)]
    )
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred is True
    assert "일치하지" in result.reason


def test_empty_evidence_is_rejected():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(3, FULL_CRITERION, evidence="  ")]
    )
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred is True
    assert "근거" in result.reason


def test_evidence_must_appear_in_answer():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(3, FULL_CRITERION, evidence="답안에 없는 글")]
    )
    result = grade_open_text(
        _item(),
        _response("6400원이므로 옳지 않다"),
        provider,
    )
    assert result.deferred
    assert "답안에서 찾을 수" in result.reason


def test_out_of_range_confidence_is_rejected_not_clamped():
    provider, _ = make_fake_llm_provider(
        responses=[_llm_output(3, FULL_CRITERION, confidence=1.2)]
    )
    result = grade_open_text(
        _item(),
        _response("6400원이므로 옳지 않다"),
        provider,
    )
    assert result.deferred
    assert "신뢰도" in result.reason


def test_malformed_json_is_rejected_without_parser_details():
    provider, _ = make_fake_llm_provider(responses=["JSON이 아닙니다"])
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred is True
    assert result.reason == "채점 응답 형식이 올바르지 않습니다."


def test_unusable_recognition_is_deferred_without_calling_llm():
    provider, adapter = make_fake_llm_provider(responses=[])
    unreadable = RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.UNREADABLE,
        confidence=0.0,
    )
    result = grade_open_text(_item(), unreadable, provider)
    assert result.deferred is True
    assert adapter.requests == []


def test_prompt_contains_only_rubric_criteria():
    item = _item()
    provider, adapter = make_fake_llm_provider(
        responses=[
            _llm_output(
                2,
                PARTIAL_CRITERION,
                evidence="6400원",
            )
        ]
    )
    grade_open_text(item, _response("6400원"), provider)
    prompt = adapter.requests[0].user_text
    for rule in item.scoring:
        assert rule.criterion in prompt


def test_student_name_is_masked_before_sending():
    provider, adapter = make_fake_llm_provider(
        responses=[
            _llm_output(0, ZERO_CRITERION, evidence="모르겠다")
        ]
    )
    grade_open_text(
        _item(),
        _response("김미래가 쓴 답: 모르겠다"),
        provider,
        pii_terms={"김미래"},
    )
    prompt = adapter.requests[0].user_text
    assert "김미래" not in prompt
    assert "[학생]" in prompt


def test_provider_failure_uses_fixed_reason():
    provider, _ = make_fake_llm_provider(
        responses=[RuntimeError("/비밀/경로와 키")]
    )
    result = grade_open_text(_item(), _response("답안"), provider)
    assert result.deferred
    assert result.reason == "서술 채점 외부 호출에 실패했습니다."
    assert "비밀" not in result.reason
