"""교사 확정 이력을 제안 점수와의 실측 일치율로 집계한다."""

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.grading import ItemScore
from app.models.review import ScoreRevision


@dataclass
class AccuracyRow:
    item_no: int | None
    item_type: str | None
    confirmed: int = 0
    agreed: int = 0

    @property
    def agreement_rate(self) -> float | None:
        if self.confirmed == 0:
            return None
        return self.agreed / self.confirmed


@dataclass
class AccuracyReport:
    by_item: list[AccuracyRow] = field(default_factory=list)
    by_type: dict[str, AccuracyRow] = field(default_factory=dict)
    auto_route_confirmed: int = 0
    auto_route_disagreements: int = 0

    @property
    def auto_route_is_safe(self) -> bool:
        """검토 표본이 있고 자동 경로의 교사 수정이 없을 때만 참이다."""
        return (
            self.auto_route_confirmed > 0
            and self.auto_route_disagreements == 0
        )


def compute_accuracy(
    session: Session,
    run_id: int,
    item_types: dict[int, str],
) -> AccuracyReport:
    """수정 이력이 있는 확정 항목 중 제안 점수가 있는 항목만 집계한다."""
    scores = session.scalars(
        select(ItemScore)
        .where(ItemScore.run_id == run_id)
        .order_by(ItemScore.item_no, ItemScore.id)
    ).all()
    reviewed_score_ids = set(
        session.scalars(
            select(ScoreRevision.item_score_id)
            .join(ItemScore, ItemScore.id == ScoreRevision.item_score_id)
            .where(ItemScore.run_id == run_id)
            .distinct()
        ).all()
    )

    per_item: dict[int, AccuracyRow] = {}
    per_type: dict[str, AccuracyRow] = {}
    report = AccuracyReport()

    for score in scores:
        item_type = item_types.get(score.item_no)
        row = per_item.setdefault(
            score.item_no,
            AccuracyRow(item_no=score.item_no, item_type=item_type),
        )

        if (
            not score.confirmed
            or score.proposed_score is None
            or score.id not in reviewed_score_ids
        ):
            continue

        agreed = score.final_score == score.proposed_score
        row.confirmed += 1
        row.agreed += int(agreed)

        if item_type is not None:
            type_row = per_type.setdefault(
                item_type,
                AccuracyRow(item_no=None, item_type=item_type),
            )
            type_row.confirmed += 1
            type_row.agreed += int(agreed)

        if score.route == "auto":
            report.auto_route_confirmed += 1
            report.auto_route_disagreements += int(not agreed)

    report.by_item = list(per_item.values())
    report.by_type = per_type
    return report
