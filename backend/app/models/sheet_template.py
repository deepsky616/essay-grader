from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.assessment import Assessment
    from app.models.document import SourceDocument


class SheetTemplate(Base, TimestampMixin):
    """빈 답안지와 정합 및 영역 지정의 공통 좌표계."""

    __tablename__ = "sheet_templates"
    __table_args__ = (
        CheckConstraint(
            "page_count BETWEEN 1 AND 62",
            name="ck_sheet_templates_page_count",
        ),
        CheckConstraint(
            "printable_path IS NULL OR "
            "length(trim(printable_path)) BETWEEN 1 AND 600",
            name="ck_sheet_templates_printable_path",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(
        ForeignKey("assessments.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    source_document_id: Mapped[int | None] = mapped_column(
        ForeignKey("source_documents.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
    page_count: Mapped[int] = mapped_column(Integer, nullable=False)
    printable_path: Mapped[str | None] = mapped_column(String(600), nullable=True)

    regions: Mapped[list[RegionSpec]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="RegionSpec.page_no, RegionSpec.region_type, RegionSpec.item_no",
    )


class RegionSpec(Base, TimestampMixin):
    """템플릿 화소 좌표계의 응답 또는 식별정보 사각형."""

    __tablename__ = "region_specs"
    __table_args__ = (
        CheckConstraint(
            "region_type IN ('response', 'pii')",
            name="ck_region_specs_type",
        ),
        CheckConstraint(
            "(region_type = 'response' AND item_no IS NOT NULL AND item_no >= 1) OR "
            "(region_type = 'pii' AND item_no IS NULL)",
            name="ck_region_specs_item_for_type",
        ),
        CheckConstraint(
            "page_no BETWEEN 1 AND 62",
            name="ck_region_specs_page_no",
        ),
        CheckConstraint(
            "x >= 0 AND y >= 0 AND width > 0 AND height > 0",
            name="ck_region_specs_geometry",
        ),
        UniqueConstraint(
            "template_id",
            "item_no",
            name="uq_region_specs_template_item",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("sheet_templates.id", ondelete="CASCADE"),
        nullable=False,
    )
    region_type: Mapped[str] = mapped_column(String(20), nullable=False)
    item_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_no: Mapped[int] = mapped_column(Integer, nullable=False)
    x: Mapped[int] = mapped_column(Integer, nullable=False)
    y: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)

    template: Mapped[SheetTemplate] = relationship(back_populates="regions")
