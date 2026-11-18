import pytest

from app.models.grading import ItemScore
from app.models.scan import Submission
from app.schemas.rubric import (
    AchievementStandard,
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    ScoringRule,
)
from app.services.confirmation import confirm_score
from app.services.feedback_builder import NotConfirmed, build_contexts


def _rubric(cutoffs: dict[str, int] | None = None) -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(
            title="수학 논술형",
            subject="수학",
            grade=6,
            total_points=4,
        ),
        achievement_standards=[
            AchievementStandard(
                id="AS1",
                item_range=[1, 2],
                core_standard="선대칭 도형과 점대칭 도형의 의미를 이해한다.",
                levels={"1": "시도한다", "2": "할 수 있다", "3": "정확하게 한다"},
            )
        ],
        items=[
            RubricItem(
                item_no=1,
                title="대칭축 찾기",
                points=2,
                standard_id="AS1",
                type=ItemType.CLOSED_SHORT,
                blanks=[Blank(key="1", answers=["선대칭"])],
                scoring=[
                    ScoringRule(
                        score=2,
                        condition="all_correct",
                        criterion="둘 다 정확",
                    ),
                    ScoringRule(
                        score=1,
                        condition="partial:1",
                        criterion="하나만",
                    ),
                    ScoringRule(
                        score=0,
                        condition="none_correct",
                        criterion="모두 틀림",
                    ),
                ],
                example_answer="1 선대칭 2 점대칭",
            ),
            RubricItem(
                item_no=2,
                title="점대칭 도형 그리기",
                points=2,
                standard_id="AS1",
                type=ItemType.DRAWING,
                scoring=[
                    ScoringRule(
                        score=2,
                        condition="manual",
                        criterion="정확하게 완성",
                    ),
                    ScoringRule(
                        score=1,
                        condition="manual",
                        criterion="일부만 완성",
                    ),
                    ScoringRule(
                        score=0,
                        condition="manual",
                        criterion="그리지 못함",
                    ),
                ],
                example_answer="예시 그림 참조",
            ),
        ],
        level_cutoffs=(
            cutoffs if cutoffs is not None else {"3": 4, "2": 2, "1": 0}
        ),
    )


def _confirm_all(db_session, run_id, score_value=2):
    for score in db_session.query(ItemScore).filter_by(run_id=run_id):
        confirm_score(
            db_session,
            score,
            new_score=score_value,
            source="teacher_accept",
        )


def test_rejects_when_items_unconfirmed(graded_setup, db_session):
    with pytest.raises(NotConfirmed) as exc:
        build_contexts(db_session, graded_setup["run"].id, _rubric())
    assert "확정" in str(exc.value)
    assert "4" in str(exc.value)


def test_builds_one_context_per_student(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    contexts = build_contexts(db_session, run_id, _rubric())
    assert len(contexts) == 2
    assert contexts[0].student_name == "김미래"
    assert contexts[0].total_score == 4


def test_context_uses_anonymous_token_for_llm(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    context = build_contexts(db_session, run_id, _rubric())[0]
    assert context.anonymous_token.startswith("S-")
    assert "김미래" not in str(context.to_llm_payload())


def test_rejects_when_anonymous_token_is_missing(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)
    submission = db_session.query(Submission).first()
    submission.anonymous_token = None
    db_session.commit()

    with pytest.raises(NotConfirmed, match="익명"):
        build_contexts(db_session, run_id, _rubric())


def test_item_detail_includes_criterion_and_max(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id, score_value=1)

    first = build_contexts(db_session, run_id, _rubric())[0].items[0]
    assert first.item_no == 1
    assert first.score == 1
    assert first.max_points == 2
    assert first.criterion == "하나만"


def test_level_and_description_are_determined(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    context = build_contexts(db_session, run_id, _rubric())[0]
    assert context.level == "3"
    assert "정확하게 한다" in context.level_description


def test_missing_cutoffs_are_rejected(graded_setup, db_session):
    run_id = graded_setup["run"].id
    _confirm_all(db_session, run_id)

    with pytest.raises(NotConfirmed, match="컷오프"):
        build_contexts(db_session, run_id, _rubric(cutoffs={}))


def test_weak_items_are_identified(graded_setup, db_session):
    run_id = graded_setup["run"].id
    for score in db_session.query(ItemScore).filter_by(run_id=run_id):
        value = 0 if score.item_no == 2 else 2
        confirm_score(db_session, score, new_score=value, source="teacher_edit")

    context = build_contexts(db_session, run_id, _rubric())[0]
    assert [item.item_no for item in context.weak_items()] == [2]


def test_failed_run_is_rejected(graded_setup, db_session):
    run = graded_setup["run"]
    run.status = "failed"
    run.failure_reason = "실패"
    db_session.commit()

    with pytest.raises(NotConfirmed, match="성공"):
        build_contexts(db_session, run.id, _rubric())


def test_missing_item_score_is_rejected(graded_setup, db_session):
    run_id = graded_setup["run"].id
    missing = db_session.query(ItemScore).filter_by(run_id=run_id, item_no=2).first()
    db_session.delete(missing)
    db_session.commit()
    _confirm_all(db_session, run_id)

    with pytest.raises(NotConfirmed, match="문항"):
        build_contexts(db_session, run_id, _rubric())
