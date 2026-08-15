import pytest
from pydantic import ValidationError

from app.schemas.rubric import (
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    ScoringRule,
)


def _minimal_item() -> RubricItem:
    return RubricItem(
        item_no=1,
        title="대칭축과 대칭의 중심 찾아보기",
        points=2,
        standard_id="AS1",
        type=ItemType.CLOSED_SHORT,
        blanks=[
            Blank(key="①", answers=["선대칭"], aliases=["선 대칭", "선대칭 도형"]),
            Blank(key="②", answers=["점대칭"], aliases=["점 대칭"]),
        ],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="선대칭과 점대칭 도형을 정확하게 씀"),
            ScoringRule(score=1, condition="partial:1", criterion="한 가지만 옳게 씀"),
            ScoringRule(score=0, condition="none_correct", criterion="모두 옳지 않음"),
        ],
    )


def test_item_parses_and_keeps_answer_candidates():
    item = _minimal_item()
    assert item.blanks[0].answers == ["선대칭"]
    assert item.scoring[0].score == 2


def test_condition_grammar_is_enforced():
    with pytest.raises(ValidationError):
        ScoringRule(score=1, condition="mostly_right", criterion="아무 말")


def test_partial_condition_accepts_count_forms():
    assert ScoringRule(score=1, condition="partial:2", criterion="x").condition == "partial:2"
    assert ScoringRule(score=1, condition="partial:>=2", criterion="x").condition == "partial:>=2"


def test_rubric_round_trips_through_json():
    rubric = Rubric(
        assessment={"title": "수학 논술형", "subject": "수학", "grade": 6, "total_points": 2},
        achievement_standards=[
            {
                "id": "AS1",
                "item_range": [1, 1],
                "core_standard": "선대칭 도형과 점대칭 도형의 의미를 이해한다.",
                "levels": {"1": "시도한다", "2": "할 수 있다", "3": "정확하게 한다"},
            }
        ],
        items=[_minimal_item()],
        level_cutoffs={"3": 2, "2": 1, "1": 0},
    )
    restored = Rubric.model_validate_json(rubric.model_dump_json())
    assert restored.items[0].blanks[1].key == "②"
