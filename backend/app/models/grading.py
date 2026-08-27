from __future__ import annotations

from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class GradingRun(Base, TimestampMixin):
    """한 스캔 배치의 다시 실행 가능한 채점 시도 한 번."""

    __tablename__ = "grading_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_grading_runs_status",
        ),
        CheckConstraint(
            "job_id IS NULL OR job_id >= 1",
            name="ck_grading_runs_job_id",
        ),
        CheckConstraint(
            "review_all IN (0, 1)",
            name="ck_grading_runs_review_all",
        ),
        CheckConstraint(
            "confidence_threshold >= 0.0 AND confidence_threshold <= 1.0",
            name="ck_grading_runs_confidence_threshold",
        ),
        CheckConstraint(
            "((status = 'failed') AND failure_reason IS NOT NULL "
            "AND length(trim(failure_reason)) BETWEEN 1 AND 500) "
            "OR ((status != 'failed') AND failure_reason IS NULL)",
            name="ck_grading_runs_failure_reason",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("scan_batches.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="pending",
    )
    failure_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    job_id: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
        unique=True,
    )
    review_all: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )
    confidence_threshold: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.90,
    )

    scores: Mapped[list[ItemScore]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ItemScore.item_no, ItemScore.id",
    )


class ItemScore(Base, TimestampMixin):
    """학생 한 명의 문항 하나에 대한 제안과 뒤 확정 결과."""

    __tablename__ = "item_scores"
    __table_args__ = (
        CheckConstraint("item_no >= 1", name="ck_item_scores_item_no"),
        CheckConstraint(
            "proposed_score IS NULL OR proposed_score >= 0",
            name="ck_item_scores_proposed_score",
        ),
        CheckConstraint(
            "final_score IS NULL OR final_score >= 0",
            name="ck_item_scores_final_score",
        ),
        CheckConstraint(
            "confirmed IN (0, 1)",
            name="ck_item_scores_confirmed",
        ),
        CheckConstraint(
            "((confirmed = 1) AND final_score IS NOT NULL) "
            "OR ((confirmed = 0) AND final_score IS NULL)",
            name="ck_item_scores_confirmation",
        ),
        CheckConstraint(
            "confidence >= 0.0 AND confidence <= 1.0",
            name="ck_item_scores_confidence",
        ),
        CheckConstraint(
            "route IN ('auto', 'manual')",
            name="ck_item_scores_route",
        ),
        CheckConstraint(
            "matched_criterion IS NULL OR "
            "length(trim(matched_criterion)) BETWEEN 1 AND 4000",
            name="ck_item_scores_matched_criterion",
        ),
        CheckConstraint(
            "length(evidence) <= 50000",
            name="ck_item_scores_evidence",
        ),
        CheckConstraint(
            "length(trim(reason)) BETWEEN 1 AND 4000",
            name="ck_item_scores_reason",
        ),
        CheckConstraint(
            "length(recognized_raw) <= 20000",
            name="ck_item_scores_recognized_raw",
        ),
        UniqueConstraint(
            "run_id",
            "submission_id",
            "item_no",
            name="uq_item_scores_run_submission_item",
        ),
        Index(
            "ix_item_scores_run_route_item",
            "run_id",
            "route",
            "item_no",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("grading_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_no: Mapped[int] = mapped_column(Integer, nullable=False)

    proposed_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    final_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confirmed: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )
    matched_criterion: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reason: Mapped[str] = mapped_column(String(4000), nullable=False)
    confidence: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
    )
    route: Mapped[str] = mapped_column(
        String(10),
        nullable=False,
        default="manual",
    )
    routing_reasons: Mapped[list[str]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
    )
    part_scores: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
    )
    recognized_raw: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
    )

    run: Mapped[GradingRun] = relationship(back_populates="scores")
