from app.schemas.rubric import (
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
)
from app.services.rubric_validator import validate_rubric


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


def test_drawing_item_does_not_require_answer_candidates():
    item = _item(1, 4, type=ItemType.DRAWING, blanks=[])
    errors = validate_rubric(_rubric([item], total=4))
    assert errors == []
