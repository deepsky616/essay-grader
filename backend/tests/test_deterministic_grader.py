import pytest

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import (
    Blank,
    ItemType,
    RubricItem,
    ScoringRule,
    TableColumn,
)
from app.services.deterministic_grader import grade_deterministic


def _classified(
    values: list[str],
    status=RecognitionStatus.OK,
    confidence=0.95,
):
    return RecognizedResponse(
        kind=RecognitionKind.CLASSIFY,
        status=status,
        values=values,
        confidence=confidence,
    )


def _item1() -> RubricItem:
    return RubricItem(
        item_no=1,
        title="대칭축과 대칭의 중심 찾아보기",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[
            Blank(key="1", answers=["선대칭"], aliases=["선 대칭"]),
            Blank(key="2", answers=["점대칭"]),
        ],
        scoring=[
            ScoringRule(
                score=2,
                condition="all_correct",
                criterion="둘 다 정확하게 씀",
            ),
            ScoringRule(
                score=1,
                condition="partial:1",
                criterion="한 가지만 옳게 씀",
            ),
            ScoringRule(
                score=0,
                condition="none_correct",
                criterion="모두 옳지 않음",
            ),
        ],
    )


def test_all_correct_gets_full_points():
    result = grade_deterministic(
        _item1(),
        _classified(["선대칭", "점대칭"]),
    )
    assert result.score == 2
    assert result.matched_criterion == "둘 다 정확하게 씀"


def test_one_correct_gets_partial_points():
    result = grade_deterministic(_item1(), _classified(["선대칭", "직선"]))
    assert result.score == 1


def test_none_correct_gets_zero():
    result = grade_deterministic(_item1(), _classified(["직선", "곡선"]))
    assert result.score == 0


def test_alias_counts_as_correct():
    result = grade_deterministic(_item1(), _classified(["선 대칭", "점대칭"]))
    assert result.score == 2


def test_alias_is_not_made_ambiguous_by_multiple_answers():
    item = _item1()
    item.blanks[0] = Blank(
        key="1",
        answers=["25%", "0.25"],
        aliases=["25 퍼센트"],
    )
    result = grade_deterministic(item, _classified(["25 퍼센트", "점대칭"]))
    assert result.score == 2


def test_none_of_above_is_graded_as_wrong_not_deferred():
    result = grade_deterministic(
        _item1(),
        _classified([], status=RecognitionStatus.NONE_OF_ABOVE),
    )
    assert result.score == 0
    assert result.deferred is False


def test_unreadable_is_deferred_to_teacher():
    result = grade_deterministic(
        _item1(),
        _classified(
            [],
            status=RecognitionStatus.UNREADABLE,
            confidence=0.0,
        ),
    )
    assert result.deferred is True
    assert result.score is None
    assert "판독" in result.reason


def test_evidence_records_recognized_values():
    result = grade_deterministic(
        _item1(),
        _classified(["선대칭", "점대칭"]),
    )
    assert "선대칭" in result.evidence


def _item2() -> RubricItem:
    return RubricItem(
        item_no=2,
        title="선대칭 도형과 점대칭 도형 구별하기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[
            TableColumn(header="선대칭인 도형", answers=["가", "라", "마"]),
            TableColumn(header="점대칭인 도형", answers=["나", "사"]),
            TableColumn(header="둘 다인 도형", answers=["다"]),
        ],
        scoring=[
            ScoringRule(
                score=2,
                condition="set_exact",
                criterion="모든 도형을 정확하게 분류함",
            ),
            ScoringRule(
                score=1,
                condition="set_partial",
                criterion="일부 도형을 분류함",
            ),
            ScoringRule(
                score=0,
                condition="none_correct",
                criterion="분류하지 못함",
            ),
        ],
    )


def test_table_exact_match():
    response = _classified(["가|라|마", "나|사", "다"], confidence=0.9)
    assert grade_deterministic(_item2(), response).score == 2


def test_table_partial_match():
    response = _classified(["가|라", "나|사", "다"], confidence=0.9)
    assert grade_deterministic(_item2(), response).score == 1


def test_table_no_match():
    response = _classified(["사", "다", "가"], confidence=0.9)
    assert grade_deterministic(_item2(), response).score == 0


def test_table_extra_column_prevents_exact_match():
    response = _classified(["가|라|마", "나|사", "다", "추가"], confidence=0.9)
    assert grade_deterministic(_item2(), response).score == 1


def test_llm_condition_item_is_rejected():
    item = _item1()
    item.scoring = [ScoringRule(score=2, condition="llm", criterion="기준")]
    with pytest.raises(ValueError, match="자동 평가"):
        grade_deterministic(item, _classified(["선대칭"]))


def test_transcription_is_not_accepted_by_deterministic_grader():
    response = RecognizedResponse(
        kind=RecognitionKind.TRANSCRIBE,
        status=RecognitionStatus.OK,
        text="선대칭 점대칭",
        confidence=0.9,
    )
    result = grade_deterministic(_item1(), response)
    assert result.deferred
    assert result.score is None
    assert "분류" in result.reason
