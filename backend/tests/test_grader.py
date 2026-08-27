import json

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import (
    Blank,
    ItemType,
    RubricItem,
    RubricPart,
    ScoringRule,
)
from app.services.grader import grade_item
from tests.fakes import make_fake_llm_provider


def _classified(values, status=RecognitionStatus.OK, confidence=0.95):
    return RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=status,
        values=values,
        confidence=confidence,
    )


def test_drawing_item_always_routes_to_teacher():
    item = RubricItem(
        item_no=4,
        title="조건에 맞는 대칭인 도형 그리기",
        points=4,
        type=ItemType.DRAWING,
        scoring=[
            ScoringRule(score=4, condition="manual", criterion="정확하게 그림"),
            ScoringRule(score=0, condition="manual", criterion="그리지 못함"),
        ],
    )
    skipped = RecognizedResponse(
        kind=RecognitionKind.SKIPPED,
        status=RecognitionStatus.SKIPPED,
        confidence=0.0,
    )
    provider, adapter = make_fake_llm_provider([])
    result = grade_item(item, {0: skipped}, provider)
    assert result.route == "manual"
    assert result.score is None
    assert "작도" in result.reason
    assert adapter.requests == []


def test_closed_short_uses_deterministic_path():
    item = RubricItem(
        item_no=1,
        title="대칭축 찾기",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[
            Blank(key="1", answers=["선대칭"]),
            Blank(key="2", answers=["점대칭"]),
        ],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
        ],
    )
    provider, adapter = make_fake_llm_provider([])
    result = grade_item(
        item,
        {0: _classified(["선대칭", "점대칭"])},
        provider,
    )
    assert result.score == 2
    assert result.route == "auto"
    assert adapter.requests == []


def _composite_item() -> RubricItem:
    return RubricItem(
        item_no=7,
        title="비율을 백분율로 나타내기",
        points=3,
        type=ItemType.COMPOSITE,
        parts=[
            RubricPart(part_id="calc", type=ItemType.OPEN_TEXT, points=1),
            RubricPart(
                part_id="values",
                type=ItemType.NUMERIC,
                points=1,
                numeric_answers=["25", "30"],
            ),
            RubricPart(
                part_id="pick",
                type=ItemType.CLOSED_SHORT,
                points=1,
                blanks=[Blank(key="1", answers=["샤프"])],
            ),
        ],
        scoring=[
            ScoringRule(score=3, condition="all_correct", criterion="모두 정확"),
            ScoringRule(score=2, condition="partial:2", criterion="두 가지 정확"),
            ScoringRule(score=1, condition="partial:1", criterion="한 가지 정확"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
        ],
    )


def test_composite_with_open_text_proposes_no_score():
    item = _composite_item()
    responses = {
        0: RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text="180/720×100=25",
            confidence=0.8,
        ),
        1: _classified(["25", "30"]),
        2: _classified(["샤프"]),
    }
    provider, adapter = make_fake_llm_provider([])
    result = grade_item(item, responses, provider)
    assert result.score is None
    assert result.route == "manual"
    assert adapter.requests == []


def test_composite_reports_each_part_outcome():
    responses = {
        0: RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text="계산",
            confidence=0.8,
        ),
        1: _classified(["25", "99"]),
        2: _classified(["샤프"]),
    }
    provider, _ = make_fake_llm_provider([])
    result = grade_item(_composite_item(), responses, provider)
    assert result.part_scores["values"] == 0
    assert result.part_scores["pick"] == 1
    assert result.part_scores["calc"] is None
    assert "오답" in result.evidence


def _closed_composite() -> RubricItem:
    return RubricItem(
        item_no=6,
        title="기호와 수치",
        points=2,
        type=ItemType.COMPOSITE,
        parts=[
            RubricPart(
                part_id="sym",
                type=ItemType.CLOSED_SHORT,
                points=1,
                blanks=[Blank(key="1", answers=["라"])],
            ),
            RubricPart(
                part_id="num",
                type=ItemType.NUMERIC,
                points=1,
                numeric_answers=["10"],
            ),
        ],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
            ScoringRule(score=1, condition="partial:1", criterion="하나만 정확"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
        ],
    )


def test_composite_without_open_text_can_auto_confirm():
    provider, _ = make_fake_llm_provider([])
    result = grade_item(
        _closed_composite(),
        {0: _classified(["라"]), 1: _classified(["10"])},
        provider,
    )
    assert result.score == 2
    assert result.route == "auto"


def test_unreadable_composite_part_forces_manual_review():
    provider, _ = make_fake_llm_provider([])
    result = grade_item(
        _closed_composite(),
        {
            0: _classified(
                [],
                status=RecognitionStatus.UNREADABLE,
                confidence=0.0,
            ),
            1: _classified(["10"]),
        },
        provider,
    )
    assert result.route == "manual"
    assert result.score is None
    assert result.part_scores["sym"] is None


def _llm_ok() -> str:
    return json.dumps(
        {
            "score": 3,
            "matched_criterion": "구체적으로 설명함",
            "evidence": "6400원",
            "reasoning": "계산과 판단이 있다",
            "confidence": 0.8,
        },
        ensure_ascii=False,
    )


def test_open_text_item_routes_to_manual_and_carries_token():
    item = RubricItem(
        item_no=8,
        title="이유 서술",
        points=3,
        type=ItemType.OPEN_TEXT,
        scoring=[
            ScoringRule(score=3, condition="llm", criterion="구체적으로 설명함"),
            ScoringRule(score=0, condition="llm", criterion="설명하지 못함"),
        ],
    )
    responses = {
        0: RecognizedResponse(
            kind=RecognitionKind.TRANSCRIBE,
            status=RecognitionStatus.OK,
            text="6400원이라 옳지 않다",
            confidence=0.8,
        )
    }
    provider, adapter = make_fake_llm_provider([_llm_ok()])
    result = grade_item(
        item,
        responses,
        provider,
        anonymous_token="S-deadbeef",
    )
    assert result.score == 3
    assert result.route == "manual"
    assert result.evidence == "6400원"
    assert adapter.requests[0].anonymous_token == "S-deadbeef"


def test_missing_response_defers():
    item = RubricItem(
        item_no=1,
        title="단답",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="1", answers=["선대칭"])],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="정확"),
            ScoringRule(score=0, condition="none_correct", criterion="틀림"),
        ],
    )
    provider, _ = make_fake_llm_provider([])
    result = grade_item(item, {}, provider)
    assert result.route == "manual"
    assert result.score is None


def test_unexpected_response_index_defers():
    provider, _ = make_fake_llm_provider([])
    result = grade_item(
        _closed_composite(),
        {
            0: _classified(["라"]),
            1: _classified(["10"]),
            2: _classified(["추가"]),
        },
        provider,
    )
    assert result.route == "manual"
    assert result.score is None
