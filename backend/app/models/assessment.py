from typing import Any

from sqlalchemy import JSON, Integer, String
from sqlalchemy.ext.mutable import MutableDict, MutableList
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class Assessment(Base, TimestampMixin):
    """평가 한 건과 루브릭 작성에 필요한 메타자료를 보관한다."""

    __tablename__ = "assessments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    subject: Mapped[str] = mapped_column(String(50), nullable=False)
    grade: Mapped[int] = mapped_column(Integer, nullable=False)
    total_points: Mapped[int] = mapped_column(Integer, nullable=False)

    achievement_standards: Mapped[list[dict[str, Any]]] = mapped_column(
        MutableList.as_mutable(JSON), nullable=False, default=list
    )
    level_cutoffs: Mapped[dict[str, int]] = mapped_column(
        MutableDict.as_mutable(JSON), nullable=False, default=dict
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
