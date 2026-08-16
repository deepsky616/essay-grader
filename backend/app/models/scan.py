from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ScanBatch(Base, TimestampMixin):
    """한 번에 올린 전체 학생 답안 스캔 PDF와 처리 상태."""

    __tablename__ = "scan_batches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'processing', 'split_failed', "
            "'ready', 'needs_review', 'failed')",
            name="ck_scan_batches_status",
        ),
        CheckConstraint(
            "length(trim(stored_path)) BETWEEN 1 AND 600",
            name="ck_scan_batches_stored_path",
        ),
        CheckConstraint(
            "job_id IS NULL OR job_id >= 1",
            name="ck_scan_batches_job_id",
        ),
        CheckConstraint(
            "((status IN ('split_failed', 'failed')) AND failure_reason IS NOT NULL) "
            "OR ((status NOT IN ('split_failed', 'failed')) AND failure_reason IS NULL)",
            name="ck_scan_batches_failure_reason",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"),
        nullable=False,
    )
    classroom_id: Mapped[int] = mapped_column(
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=False,
    )
    stored_path: Mapped[str] = mapped_column(String(600), nullable=False)
    status: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="pending",
    )
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, unique=True)

    submissions: Mapped[list[Submission]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Submission.page_start",
    )


class Submission(Base, TimestampMixin):
    """배치 안 한 학생의 반열린 원본 쪽 범위와 배정 상태."""

    __tablename__ = "submissions"
    __table_args__ = (
        CheckConstraint(
            "page_start >= 0 AND page_end > page_start",
            name="ck_submissions_page_range",
        ),
        CheckConstraint(
            "assignment_status IN ('pending', 'confirmed', 'needs_review')",
            name="ck_submissions_assignment_status",
        ),
        CheckConstraint(
            "recognized_name IS NULL OR "
            "length(trim(recognized_name)) BETWEEN 1 AND 50",
            name="ck_submissions_recognized_name",
        ),
        CheckConstraint(
            "anonymous_token IS NULL OR "
            "(length(anonymous_token) = 10 AND substr(anonymous_token, 1, 2) = 'S-')",
            name="ck_submissions_anonymous_token",
        ),
        UniqueConstraint(
            "batch_id",
            "student_id",
            name="uq_submissions_batch_student",
        ),
        UniqueConstraint(
            "batch_id",
            "page_start",
            name="uq_submissions_batch_page_start",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("scan_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    student_id: Mapped[int] = mapped_column(
        ForeignKey("students.id", ondelete="CASCADE"),
        nullable=False,
    )
    page_start: Mapped[int] = mapped_column(Integer, nullable=False)
    page_end: Mapped[int] = mapped_column(Integer, nullable=False)
    assignment_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="pending",
    )
    recognized_name: Mapped[str | None] = mapped_column(String(50), nullable=True)
    assignment_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    anonymous_token: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
        unique=True,
    )

    batch: Mapped[ScanBatch] = relationship(back_populates="submissions")
    pages: Mapped[list[PageImage]] = relationship(
        back_populates="submission",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PageImage.page_no",
    )
    item_responses: Mapped[list[ItemResponse]] = relationship(
        back_populates="submission",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ItemResponse.item_no",
    )


class PageImage(Base, TimestampMixin):
    __tablename__ = "page_images"
    __table_args__ = (
        CheckConstraint(
            "page_no BETWEEN 1 AND 62",
            name="ck_page_images_page_no",
        ),
        CheckConstraint(
            "registration_quality >= 0.0 AND registration_quality <= 1.0",
            name="ck_page_images_registration_quality",
        ),
        CheckConstraint(
            "length(trim(aligned_path)) BETWEEN 1 AND 600 "
            "AND length(trim(ink_path)) BETWEEN 1 AND 600",
            name="ck_page_images_paths",
        ),
        UniqueConstraint(
            "submission_id",
            "page_no",
            name="uq_page_images_submission_page",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"),
        nullable=False,
    )
    page_no: Mapped[int] = mapped_column(Integer, nullable=False)
    aligned_path: Mapped[str] = mapped_column(String(600), nullable=False)
    ink_path: Mapped[str] = mapped_column(String(600), nullable=False)
    registration_quality: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
    )

    submission: Mapped[Submission] = relationship(back_populates="pages")


class ItemResponse(Base, TimestampMixin):
    """학생 한 명의 문항별 비식별 응답 크롭."""

    __tablename__ = "item_responses"
    __table_args__ = (
        CheckConstraint("item_no >= 1", name="ck_item_responses_item_no"),
        CheckConstraint(
            "length(trim(crop_path)) BETWEEN 1 AND 600",
            name="ck_item_responses_crop_path",
        ),
        CheckConstraint(
            "ink_crop_path IS NULL OR "
            "length(trim(ink_crop_path)) BETWEEN 1 AND 600",
            name="ck_item_responses_ink_crop_path",
        ),
        UniqueConstraint(
            "submission_id",
            "item_no",
            name="uq_item_responses_submission_item",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"),
        nullable=False,
    )
    item_no: Mapped[int] = mapped_column(Integer, nullable=False)
    crop_path: Mapped[str] = mapped_column(String(600), nullable=False)
    ink_crop_path: Mapped[str | None] = mapped_column(String(600), nullable=True)

    submission: Mapped[Submission] = relationship(back_populates="item_responses")
