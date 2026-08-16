"""같은 실행에서 모두 확정된 점수만 피드백 입력으로 조립한다."""

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.classroom import Student
from app.models.grading import GradingRun, ItemScore
from app.models.scan import Submission
from app.schemas.rubric import Rubric, RubricItem
from app.services.levels import LevelError, determine_level


class NotConfirmed(Exception):
    """피드백을 만들 만큼 검토가 끝나지 않았거나 자료가 맞지 않을 때 발생한다."""


@dataclass(frozen=True)
class ItemDetail:
    item_no: int
    title: str
    score: int
    max_points: int
    criterion: str
    example_answer: str
    standard_id: str | None

    @property
    def is_full(self) -> bool:
        return self.score >= self.max_points


@dataclass(frozen=True)
class FeedbackContext:
    submission_id: int
    student_number: int
    student_name: str
    anonymous_token: str
    grade: int
    subject: str
    total_score: int
    total_points: int
    level: str | None
    level_description: str
    level_warning: str | None
    items: list[ItemDetail] = field(default_factory=list)
    standards: list[dict[str, Any]] = field(default_factory=list)

    def weak_items(self) -> list[ItemDetail]:
        return [item for item in self.items if not item.is_full]

    def to_llm_payload(self) -> dict[str, Any]:
        """실명 없이 외부 피드백 생성에 필요한 최소 자료만 돌려준다."""
        return {
            "student": self.anonymous_token,
            "grade": self.grade,
            "subject": self.subject,
            "total_score": self.total_score,
            "total_points": self.total_points,
            "level": self.level,
            "level_description": self.level_description,
            "items": [
                {
                    "item_no": item.item_no,
                    "title": item.title,
                    "score": item.score,
                    "max_points": item.max_points,
                    "criterion": item.criterion,
                    "example_answer": item.example_answer,
                }
                for item in self.items
            ],
            "standards": self.standards,
        }


def _criterion_for(item: RubricItem, score: int) -> str:
    matches = [rule.criterion for rule in item.scoring if rule.score == score]
    if len(matches) != 1:
        raise NotConfirmed(
            f"{item.item_no}번의 확정 점수 {score}점에 맞는 채점 기준이 하나가 아닙니다."
        )
    return matches[0]


def build_contexts(
    session: Session,
    run_id: int,
    rubric: Rubric,
) -> list[FeedbackContext]:
    run = session.get(GradingRun, run_id)
    if run is None:
        raise NotConfirmed("채점 실행을 찾을 수 없습니다.")
    if run.status != "succeeded":
        raise NotConfirmed("성공한 채점 실행만 피드백을 만들 수 있습니다.")

    scores = session.scalars(
        select(ItemScore)
        .where(ItemScore.run_id == run_id)
        .order_by(ItemScore.submission_id, ItemScore.item_no)
    ).all()
    if not scores:
        raise NotConfirmed("채점 결과가 없습니다.")
    pending = [score for score in scores if not score.confirmed]
    if pending:
        raise NotConfirmed(
            f"확정되지 않은 채점 항목이 {len(pending)}건 남아 있습니다. "
            "검토를 모두 마친 뒤 피드백을 생성하세요."
        )

    try:
        level_probe = determine_level(0, rubric.level_cutoffs)
    except LevelError as exc:
        raise NotConfirmed(str(exc)) from exc
    if level_probe != "1":
        raise NotConfirmed("성취수준 컷오프가 0점을 1수준으로 판정하지 않습니다.")

    by_item = {item.item_no: item for item in rubric.items}
    expected_items = set(by_item)
    submissions = session.scalars(
        select(Submission)
        .where(Submission.batch_id == run.batch_id)
        .order_by(Submission.id)
    ).all()
    if not submissions:
        raise NotConfirmed("채점 실행에 학생 답안이 없습니다.")

    grouped: dict[int, list[ItemScore]] = {}
    for score in scores:
        grouped.setdefault(score.submission_id, []).append(score)
    if set(grouped) != {submission.id for submission in submissions}:
        raise NotConfirmed("채점 실행의 학생 답안과 점수 묶음이 서로 다릅니다.")

    standards_by_id = {
        standard.id: standard for standard in rubric.achievement_standards
    }
    contexts: list[FeedbackContext] = []
    for submission in submissions:
        student = session.get(Student, submission.student_id)
        if student is None:
            raise NotConfirmed("답안의 지역 학생 자료를 찾을 수 없습니다.")
        if submission.assignment_status != "confirmed":
            raise NotConfirmed("학생 배정이 확정되지 않은 답안이 있습니다.")
        if not submission.anonymous_token:
            raise NotConfirmed("익명 토큰이 없는 답안이 있습니다.")

        item_scores = grouped[submission.id]
        actual_items = {score.item_no for score in item_scores}
        if len(item_scores) != len(expected_items) or actual_items != expected_items:
            raise NotConfirmed(
                f"{student.number}번 학생의 확정 문항이 루브릭 문항과 다릅니다."
            )

        details: list[ItemDetail] = []
        for score in sorted(item_scores, key=lambda value: value.item_no):
            rubric_item = by_item[score.item_no]
            final_score = score.final_score
            if (
                isinstance(final_score, bool)
                or not isinstance(final_score, int)
                or not 0 <= final_score <= rubric_item.points
            ):
                raise NotConfirmed(
                    f"{score.item_no}번 확정 점수가 문항 배점과 맞지 않습니다."
                )
            details.append(
                ItemDetail(
                    item_no=score.item_no,
                    title=rubric_item.title,
                    score=final_score,
                    max_points=rubric_item.points,
                    criterion=_criterion_for(rubric_item, final_score),
                    example_answer=rubric_item.example_answer,
                    standard_id=rubric_item.standard_id,
                )
            )

        total = sum(detail.score for detail in details)
        if total > rubric.assessment.total_points:
            raise NotConfirmed("학생 총점이 평가 총점을 초과합니다.")
        try:
            level = determine_level(total, rubric.level_cutoffs)
        except LevelError as exc:
            raise NotConfirmed(str(exc)) from exc

        used_standard_ids = {
            detail.standard_id for detail in details if detail.standard_id is not None
        }
        standards = [
            {
                "id": standard.id,
                "core_standard": standard.core_standard,
                "level_description": standard.levels[level],
            }
            for standard_id, standard in standards_by_id.items()
            if standard_id in used_standard_ids
        ]
        descriptions = list(
            dict.fromkeys(
                standard["level_description"] for standard in standards
            )
        )
        contexts.append(
            FeedbackContext(
                submission_id=submission.id,
                student_number=student.number,
                student_name=student.name,
                anonymous_token=submission.anonymous_token,
                grade=rubric.assessment.grade,
                subject=rubric.assessment.subject,
                total_score=total,
                total_points=rubric.assessment.total_points,
                level=level,
                level_description=" ".join(descriptions),
                level_warning=None,
                items=details,
                standards=standards,
            )
        )

    contexts.sort(key=lambda context: context.student_number)
    return contexts
