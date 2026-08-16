from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.mutable_json import NestedMutableList


class Feedback(Base, TimestampMixin):
    """한 채점 실행에서 학생 한 명에게 만든 익명 피드백 내용."""

    __tablename__ = "feedbacks"
    __table_args__ = (
        CheckConstraint("total_score >= 0", name="ck_feedbacks_total_score"),
        CheckConstraint(
            "level IS NULL OR level IN ('1', '2', '3')",
            name="ck_feedbacks_level",
        ),
        CheckConstraint(
            "length(summary) <= 10000",
            name="ck_feedbacks_summary",
        ),
        CheckConstraint(
            "length(next_step) <= 10000",
            name="ck_feedbacks_next_step",
        ),
        UniqueConstraint(
            "run_id",
            "submission_id",
            name="uq_feedbacks_run_submission",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("grading_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"),
        nullable=False,
    )
    total_score: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[str | None] = mapped_column(String(5), nullable=True)
    item_comments: Mapped[list[dict[str, Any]]] = mapped_column(
        NestedMutableList.as_mutable(JSON),
        nullable=False,
        default=list,
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    next_step: Mapped[str] = mapped_column(Text, nullable=False, default="")
