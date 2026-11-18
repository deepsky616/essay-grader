from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.mutable_json import NestedMutableDict, NestedMutableList

if TYPE_CHECKING:
    from app.models.assessment import Assessment


class RubricDraft(Base, TimestampMixin):
    """컴파일 뒤 교사가 검토하고 확정하는 평가별 루브릭 초안."""

    __tablename__ = "rubric_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    content: Mapped[dict[str, Any]] = mapped_column(
        NestedMutableDict.as_mutable(JSON), nullable=False
    )
    warnings: Mapped[list[dict[str, Any]]] = mapped_column(
        NestedMutableList.as_mutable(JSON), nullable=False, default=list
    )
    confirmed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    assessment: Mapped[Assessment] = relationship(back_populates="rubric_draft")
