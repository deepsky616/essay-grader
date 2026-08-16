"""점수 확정과 수정 이력을 한 경로에서 함께 처리한다."""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.grading import ItemScore
from app.models.review import ScoreRevision


_REVISION_SOURCES = frozenset({"teacher_edit", "teacher_accept", "bulk_accept"})


class ConfirmationError(Exception):
    """점수를 안전하게 확정할 수 없을 때 발생한다."""


@dataclass(frozen=True)
class SubmissionTotal:
    points: int
    confirmed: int
    pending: int

    @property
    def complete(self) -> bool:
        return self.pending == 0


def confirm_score(
    session: Session,
    score: ItemScore,
    new_score: int,
    source: str,
    note: str | None = None,
    max_points: int | None = None,
) -> ItemScore:
    """점수를 확정하고 제안값 또는 직전 확정값과 함께 이력을 남긴다."""
    if isinstance(new_score, bool) or not isinstance(new_score, int):
        raise ConfirmationError("점수는 정수여야 합니다.")
    if new_score < 0:
        raise ConfirmationError(f"점수는 음수일 수 없습니다: {new_score}")
    if max_points is not None:
        if isinstance(max_points, bool) or not isinstance(max_points, int):
            raise ConfirmationError("문항 배점은 정수여야 합니다.")
        if max_points < 0:
            raise ConfirmationError("문항 배점은 음수일 수 없습니다.")
        if new_score > max_points:
            raise ConfirmationError(
                f"점수 {new_score}가 문항 배점 {max_points}을 초과합니다."
            )
    if source not in _REVISION_SOURCES:
        raise ConfirmationError("점수 수정 출처가 올바르지 않습니다.")
    if note is not None:
        note = note.strip()
        if not 1 <= len(note) <= 4000:
            raise ConfirmationError("수정 메모는 1자 이상 4000자 이하여야 합니다.")
    if score.id is None:
        raise ConfirmationError("저장되지 않은 점수는 확정할 수 없습니다.")

    previous = score.final_score if score.confirmed else score.proposed_score
    session.add(
        ScoreRevision(
            item_score_id=score.id,
            previous_score=previous,
            new_score=new_score,
            source=source,
            note=note,
        )
    )
    score.final_score = new_score
    score.confirmed = True
    session.commit()
    return score


def bulk_accept_auto(session: Session, run_id: int) -> int:
    """자동 경로의 제안 점수가 있는 미확정 항목만 한 번에 확정한다."""
    candidates = session.scalars(
        select(ItemScore)
        .where(
            ItemScore.run_id == run_id,
            ItemScore.route == "auto",
            ItemScore.confirmed.is_(False),
            ItemScore.proposed_score.is_not(None),
        )
        .order_by(ItemScore.id)
    ).all()

    for score in candidates:
        proposed = score.proposed_score
        if proposed is None:
            continue
        session.add(
            ScoreRevision(
                item_score_id=score.id,
                previous_score=proposed,
                new_score=proposed,
                source="bulk_accept",
            )
        )
        score.final_score = proposed
        score.confirmed = True

    session.commit()
    return len(candidates)


def submission_total(
    session: Session,
    submission_id: int,
    *,
    run_id: int | None = None,
) -> SubmissionTotal:
    query = select(ItemScore).where(ItemScore.submission_id == submission_id)
    if run_id is not None:
        query = query.where(ItemScore.run_id == run_id)
    scores = session.scalars(query.order_by(ItemScore.id)).all()
    confirmed_scores = [score for score in scores if score.confirmed]
    return SubmissionTotal(
        points=sum(score.final_score or 0 for score in confirmed_scores),
        confirmed=len(confirmed_scores),
        pending=len(scores) - len(confirmed_scores),
    )
