from typing import Any

from sqlalchemy import JSON, CheckConstraint, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Job(Base, TimestampMixin):
    """한 개의 지역 뒤 작업과 공개 가능한 진행 상태."""

    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_jobs_status",
        ),
        CheckConstraint(
            "progress_done >= 0 AND progress_total >= 0 "
            "AND progress_done <= progress_total",
            name="ck_jobs_progress_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_type: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress_done: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    progress_total: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    progress_message: Mapped[str] = mapped_column(
        String(200), nullable=False, default=""
    )
