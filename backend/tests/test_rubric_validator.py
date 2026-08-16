import pytest

from app.schemas.rubric import (
    AssessmentMeta,
    AchievementStandard,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
    TableColumn,
)
from app.services.rubric_validator import validate_level_cutoffs, validate_rubric


def _item(item_no: int, points: int, **kwargs) -> RubricItem:
    defaults = dict(
        title=f"{item_no}번 문항",
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="①", answers=["정답"])],
        scoring=[
            ScoringRule(score=points, condition="all_correct", criterion="맞음"),
            ScoringRule(score=0, condition="none_correct", criterion="틀림"),
        ],
    )
    defaults.update(kwargs)
    return RubricItem(item_no=item_no, points=points, **defaults)


def _rubric(items: list[RubricItem], total: int) -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(title="t", subject="수학", grade=6, total_points=total),
        items=items,
    )


def test_valid_rubric_has_no_errors():
    errors = validate_rubric(_rubric([_item(1, 2), _item(2, 3)], total=5))
    assert errors == []


def test_points_sum_must_equal_total():
    errors = validate_rubric(_rubric([_item(1, 2), _item(2, 3)], total=20))
    assert any("배점 합계" in error.message for error in errors)


def test_item_numbers_must_be_consecutive_from_one():
    errors = validate_rubric(_rubric([_item(1, 2), _item(3, 3)], total=5))
    assert any("문항 번호" in error.message for error in errors)


def test_scoring_must_contain_full_points_rule():
    item = _item(1, 2)
    item.scoring = [ScoringRule(score=1, condition="all_correct", criterion="x")]
    errors = validate_rubric(_rubric([item], total=2))
    assert any("만점" in error.message for error in errors)


def test_scoring_must_contain_zero_rule():
    item = _item(1, 2)
    item.scoring = [ScoringRule(score=2, condition="all_correct", criterion="x")]
    errors = validate_rubric(_rubric([item], total=2))
    assert any("0점" in error.message for error in errors)


def test_score_cannot_exceed_item_points():
    item = _item(1, 2)
    item.scoring.append(ScoringRule(score=5, condition="partial:1", criterion="x"))
    errors = validate_rubric(_rubric([item], total=2))
    assert any("배점을 초과" in error.message for error in errors)


def test_closed_short_requires_blanks():
    item = _item(1, 2, blanks=[])
    errors = validate_rubric(_rubric([item], total=2))
    assert any("정답 후보" in error.message for error in errors)


def test_composite_parts_must_sum_to_item_points():
    item = _item(
        1,
        3,
        type=ItemType.COMPOSITE,
        blanks=[],
        parts=[
            RubricPart(part_id="a", type=ItemType.NUMERIC, points=1, numeric_answers=["25"]),
            RubricPart(part_id="b", type=ItemType.NUMERIC, points=1, numeric_answers=["30"]),
        ],
    )
    errors = validate_rubric(_rubric([item], total=3))
    assert any("하위 파트" in error.message for error in errors)


def test_unknown_standard_id_is_reported():
    item = _item(1, 2, standard_id="AS9")
    errors = validate_rubric(_rubric([item], total=2))
    assert any("성취기준" in error.message for error in errors)


def test_level_cutoffs_must_decrease():
    rubric = _rubric([_item(1, 20)], total=20)
    rubric.level_cutoffs = {"3": 10, "2": 15, "1": 0}
    errors = validate_rubric(rubric)
    assert any("컷오프" in error.message for error in errors)


@pytest.mark.parametrize("invalid_key", ["03", "4", "0", "-1", 1])
def test_level_cutoff_validator_rejects_keys_outside_closed_set(invalid_key):
    errors = validate_level_cutoffs(20, {invalid_key: 0})

    assert errors
    assert errors[0].path == "level_cutoffs"


def test_drawing_item_does_not_require_answer_candidates():
    item = _item(
        1,
        4,
        type=ItemType.DRAWING,
        blanks=[],
        scoring=[
            ScoringRule(score=4, condition="manual", criterion="교사 판정"),
            ScoringRule(score=0, condition="manual", criterion="교사 판정"),
        ],
    )
    errors = validate_rubric(_rubric([item], total=4))
    assert errors == []


def test_type_specific_scoring_conditions_are_accepted():
    table = _item(
        1,
        2,
        type=ItemType.CLOSED_TABLE,
        blanks=[],
        columns=[TableColumn(header="분류", answers=["가"]), TableColumn(header="분류", answers=["나"])],
        scoring=[
            ScoringRule(score=2, condition="set_exact", criterion="일치"),
            ScoringRule(score=0, condition="set_partial", criterion="일부 일치"),
        ],
    )
    drawing = _item(
        2,
        2,
        type=ItemType.DRAWING,
        blanks=[],
        scoring=[
            ScoringRule(score=2, condition="manual", criterion="교사 판정"),
            ScoringRule(score=0, condition="manual", criterion="교사 판정"),
        ],
    )
    open_text = _item(
        3,
        2,
        type=ItemType.OPEN_TEXT,
        blanks=[],
        scoring=[
            ScoringRule(score=2, condition="llm", criterion="판정"),
            ScoringRule(score=0, condition="llm", criterion="판정"),
        ],
    )
    assert validate_rubric(_rubric([table, drawing, open_text], total=6)) == []


def test_type_specific_scoring_conditions_are_rejected_and_accumulated():
    closed_short = _item(
        1,
        2,
        scoring=[
            ScoringRule(score=2, condition="manual", criterion="x"),
            ScoringRule(score=0, condition="llm", criterion="x"),
        ],
    )
    drawing = _item(2, 2, type=ItemType.DRAWING, blanks=[])
    open_text = _item(3, 2, type=ItemType.OPEN_TEXT, blanks=[])
    table = _item(
        4,
        2,
        type=ItemType.CLOSED_TABLE,
        blanks=[],
        columns=[TableColumn(header="분류", answers=["가"])],
        scoring=[
            ScoringRule(score=2, condition="all_correct", criterion="x"),
            ScoringRule(score=0, condition="none_correct", criterion="x"),
        ],
    )
    errors = validate_rubric(_rubric([closed_short, drawing, open_text, table], total=8))
    assert sum("조건식" in error.message for error in errors) == 8


def test_choice_correct_answer_must_be_a_candidate():
    item = _item(
        1,
        2,
        type=ItemType.CHOICE,
        blanks=[],
        choices=["가", "나"],
        correct_choice="다",
    )
    errors = validate_rubric(_rubric([item], total=2))
    assert any("선택지" in error.message for error in errors)


def test_closed_table_each_column_requires_answers():
    item = _item(
        1,
        2,
        type=ItemType.CLOSED_TABLE,
        blanks=[],
        columns=[TableColumn(header="가", answers=["x"]), TableColumn(header="나")],
        scoring=[
            ScoringRule(score=2, condition="set_exact", criterion="x"),
            ScoringRule(score=0, condition="set_partial", criterion="x"),
        ],
    )
    errors = validate_rubric(_rubric([item], total=2))
    assert any("열" in error.message and "정답 후보" in error.message for error in errors)


def test_composite_parts_validate_choice_and_table_candidates():
    item = _item(
        1,
        2,
        type=ItemType.COMPOSITE,
        blanks=[],
        parts=[
            RubricPart(
                part_id="가",
                type=ItemType.CHOICE,
                points=1,
                choices=["가"],
                correct_choice="나",
            ),
            RubricPart(
                part_id="나",
                type=ItemType.CLOSED_TABLE,
                points=1,
                columns=[TableColumn(header="분류")],
            ),
        ],
    )
    errors = validate_rubric(_rubric([item], total=2))
    assert sum("정답 후보" in error.message or "선택지" in error.message for error in errors) == 2


def test_standard_id_item_must_be_within_standard_range():
    item = _item(1, 2, standard_id="AS1")
    rubric = _rubric([item], total=2)
    rubric.achievement_standards = [
        AchievementStandard(
            id="AS1",
            item_range=[2, 3],
            core_standard="기준",
            levels={"1": "기초", "2": "보통", "3": "높음"},
        )
    ]
    errors = validate_rubric(rubric)
    assert any("범위" in error.message for error in errors)
