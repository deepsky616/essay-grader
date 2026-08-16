from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ScoreRevision(Base, TimestampMixin):
    """점수 제안이나 확정값을 교사가 받아들이거나 바꾼 기록."""

    __tablename__ = "score_revisions"
    __table_args__ = (
        CheckConstraint(
            "previous_score IS NULL OR previous_score >= 0",
            name="ck_score_revisions_previous_score",
        ),
        CheckConstraint(
            "new_score >= 0",
            name="ck_score_revisions_new_score",
        ),
        CheckConstraint(
            "source IN ('teacher_edit', 'teacher_accept', 'bulk_accept')",
            name="ck_score_revisions_source",
        ),
        CheckConstraint(
            "actor = 'local_teacher'",
            name="ck_score_revisions_actor",
        ),
        CheckConstraint(
            "note IS NULL OR length(trim(note)) BETWEEN 1 AND 4000",
            name="ck_score_revisions_note",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_score_id: Mapped[int] = mapped_column(
        ForeignKey("item_scores.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    previous_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_score: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(30), nullable=False)
    actor: Mapped[str] = mapped_column(
        String(50), nullable=False, default="local_teacher"
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
