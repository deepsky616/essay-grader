from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Classroom(Base, TimestampMixin):
    __tablename__ = "classrooms"
    __table_args__ = (
        CheckConstraint(
            "length(trim(name)) BETWEEN 1 AND 100",
            name="ck_classrooms_name",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    students: Mapped[list[Student]] = relationship(
        back_populates="classroom",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Student.number",
    )

    def present_students(self) -> list[Student]:
        return [student for student in self.students if not student.absent]

    def roster_names(self) -> list[str]:
        return [student.name for student in self.students]


class Student(Base, TimestampMixin):
    __tablename__ = "students"
    __table_args__ = (
        CheckConstraint("number >= 1", name="ck_students_number"),
        CheckConstraint(
            "length(trim(name)) BETWEEN 1 AND 50",
            name="ck_students_name",
        ),
        UniqueConstraint(
            "classroom_id",
            "number",
            name="uq_students_classroom_number",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    classroom_id: Mapped[int] = mapped_column(
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=False,
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    absent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    classroom: Mapped[Classroom] = relationship(back_populates="students")
