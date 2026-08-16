import pytest
from pydantic import ValidationError

from app.schemas.rubric import (
    AchievementStandard,
    AnswerSpec,
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
    TableColumn,
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


@pytest.mark.parametrize(
    "build",
    [
        lambda: Blank(key="   ", answers=["정답"]),
        lambda: Blank(key="①", answers=["   "]),
        lambda: Blank(key="①", answers=["정답"], aliases=["   "]),
        lambda: TableColumn(header="   ", answers=["①"]),
        lambda: TableColumn(header="분류", answers=["   "]),
        lambda: AnswerSpec(numeric_answers=["   "]),
        lambda: AnswerSpec(choices=["   "]),
        lambda: AnswerSpec(choices=["가"], correct_choice="   "),
        lambda: ScoringRule(
            score=1, condition="all_correct", criterion="   "
        ),
        lambda: RubricPart(
            part_id="   ", type=ItemType.NUMERIC, points=1,
            numeric_answers=["1"],
        ),
        lambda: RubricItem(
            item_no=1,
            title="   ",
            points=1,
            type=ItemType.CLOSED_SHORT,
            blanks=[Blank(key="①", answers=["정답"])],
            scoring=[
                ScoringRule(
                    score=1, condition="all_correct", criterion="맞음"
                )
            ],
        ),
        lambda: RubricItem(
            item_no=1,
            title="문항",
            points=1,
            standard_id="   ",
            type=ItemType.CLOSED_SHORT,
            blanks=[Blank(key="①", answers=["정답"])],
            scoring=[
                ScoringRule(
                    score=1, condition="all_correct", criterion="맞음"
                )
            ],
        ),
        lambda: AchievementStandard(
            id="   ", item_range=[1, 1], core_standard="기준",
            levels={"1": "기초"},
        ),
        lambda: AchievementStandard(
            id="AS1", item_range=[1, 1], core_standard="   ",
            levels={"1": "기초"},
        ),
        lambda: AchievementStandard(
            id="AS1", item_range=[1, 1], core_standard="기준",
            levels={"1": "   "},
        ),
        lambda: AchievementStandard(
            id="AS1", item_range=[1, 1], core_standard="기준",
            levels={"   ": "기초"},
        ),
        lambda: AssessmentMeta(
            title="   ", subject="수학", grade=6, total_points=1
        ),
        lambda: AssessmentMeta(
            title="평가", subject="   ", grade=6, total_points=1
        ),
    ],
    ids=[
        "blank-key",
        "blank-answer",
        "blank-alias",
        "column-header",
        "column-answer",
        "numeric-answer",
        "choice",
        "correct-choice",
        "criterion",
        "part-id",
        "item-title",
        "standard-id-reference",
        "standard-id",
        "core-standard",
        "level-description",
        "level-name",
        "assessment-title",
        "assessment-subject",
    ],
)
def test_required_rubric_strings_reject_whitespace_only(build):
    with pytest.raises(ValidationError):
        build()


def test_nonblank_rubric_source_text_is_validated_without_normalizing_it():
    blank = Blank(
        key=" ① ", answers=[" 정답 "], aliases=[" 별칭 "]
    )

    assert blank.key == " ① "
    assert blank.answers == [" 정답 "]
    assert blank.aliases == [" 별칭 "]


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
