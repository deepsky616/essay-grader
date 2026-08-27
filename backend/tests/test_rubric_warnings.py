from app.schemas.rubric import (
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
    TableColumn,
)
from app.services.rubric_warnings import detect_warnings


def _rubric(items: list[RubricItem], total: int, **kwargs) -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(title="t", subject="수학", grade=6, total_points=total),
        items=items,
        **kwargs,
    )


def _scoring(points: int) -> list[ScoringRule]:
    return [
        ScoringRule(score=points, condition="all_correct", criterion="맞음"),
        ScoringRule(score=0, condition="none_correct", criterion="틀림"),
    ]


def test_symbol_family_mismatch_is_warned_with_item_path():
    """문항 본문은 ㉠부터 ㉦, 예시답안은 ①부터 ⑦인 실제 자료 사례."""
    item = RubricItem(
        item_no=1,
        title="선대칭 도형과 점대칭 도형 구별하기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[
            TableColumn(header="선대칭인 도형", answers=["①", "④", "⑤"]),
            TableColumn(header="점대칭인 도형", answers=["②", "⑦"]),
        ],
        scoring=_scoring(2),
        example_answer="보기 ㉠㉡㉢㉣㉤㉥㉦ 중에서 고른다",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    mismatch = next(w for w in warnings if w.code == "symbol_family_mismatch")
    assert mismatch.path == "items[1]"


def test_mixed_symbol_families_inside_one_item_are_warned():
    item = RubricItem(
        item_no=1,
        title="보기 ㉠과 ㉡을 고르기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[TableColumn(header="분류", answers=["㉠", "①"])],
        scoring=_scoring(2),
        example_answer="보기의 기호를 사용한다",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert any(w.code == "symbol_family_mismatch" for w in warnings)


def test_scoring_criterion_and_composite_part_candidates_are_checked_together():
    item = RubricItem(
        item_no=1,
        title="보기에서 고르기",
        points=1,
        type=ItemType.COMPOSITE,
        parts=[
            RubricPart(
                part_id="기호",
                type=ItemType.CLOSED_SHORT,
                points=1,
                blanks=[Blank(key="빈칸", answers=["㉠"])],
            )
        ],
        scoring=[
            ScoringRule(
                score=1,
                condition="all_correct",
                criterion="①을 정확하게 고름",
            ),
            ScoringRule(
                score=0,
                condition="none_correct",
                criterion="고르지 못함",
            ),
        ],
        example_answer="보기의 기호를 사용한다",
    )

    warnings = detect_warnings(_rubric([item], total=1))

    assert any(w.code == "symbol_family_mismatch" for w in warnings)
    assert item.parts[0].blanks[0].answers == ["㉠"]
    assert item.scoring[0].criterion == "①을 정확하게 고름"


def test_matching_symbol_family_is_not_warned():
    item = RubricItem(
        item_no=1,
        title="구별하기",
        points=2,
        type=ItemType.CLOSED_TABLE,
        columns=[TableColumn(header="선대칭", answers=["㉠", "㉣"])],
        scoring=_scoring(2),
        example_answer="보기 ㉠㉡㉢㉣ 중에서 고른다",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert not any(w.code == "symbol_family_mismatch" for w in warnings)


def test_missing_example_answer_is_warned():
    item = RubricItem(
        item_no=1,
        title="서술",
        points=2,
        type=ItemType.OPEN_TEXT,
        scoring=_scoring(2),
        example_answer="",
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert any(w.code == "missing_example_answer" for w in warnings)


def test_drawing_item_is_flagged_as_manual_review():
    item = RubricItem(
        item_no=1, title="작도", points=4, type=ItemType.DRAWING, scoring=_scoring(4)
    )
    warnings = detect_warnings(_rubric([item], total=4))
    manual = [w for w in warnings if w.code == "manual_review_required"]
    assert len(manual) == 1
    assert "4점" in manual[0].message


def test_missing_level_cutoffs_is_warned():
    item = RubricItem(
        item_no=1,
        title="단답",
        points=2,
        type=ItemType.CLOSED_SHORT,
        blanks=[Blank(key="①", answers=["선대칭"])],
        scoring=_scoring(2),
    )
    warnings = detect_warnings(_rubric([item], total=2))
    assert any(w.code == "missing_level_cutoffs" for w in warnings)
