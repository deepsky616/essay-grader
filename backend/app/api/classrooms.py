import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StringConstraints,
    model_validator,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.db import get_session
from app.models.classroom import Classroom, Student


router = APIRouter(prefix="/api/classrooms", tags=["classrooms"])

ClassroomName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
]
StudentName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=50),
]
StudentNumber = Annotated[StrictInt, Field(ge=1, le=9999)]

ROSTER_LINE = re.compile(r"^\s*([1-9]\d{0,3})[ \t]+(.+?)\s*$")
MAX_ROSTER_STUDENTS = 500
MAX_ROSTER_TEXT_LENGTH = 50_000


class StudentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    number: StudentNumber
    name: StudentName
    absent: StrictBool = False


class StudentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    number: int
    name: str
    absent: bool


class ClassroomIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ClassroomName
    students: Annotated[
        list[StudentIn],
        Field(min_length=1, max_length=MAX_ROSTER_STUDENTS),
    ]


class ClassroomOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    students: list[StudentOut]


class StudentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StudentName | None = None
    absent: StrictBool | None = None

    @model_validator(mode="after")
    def require_change(self) -> "StudentPatch":
        if self.name is None and self.absent is None:
            raise ValueError("바꿀 학생 정보가 없습니다.")
        return self


class RosterText(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=MAX_ROSTER_TEXT_LENGTH)]


def _commit_or_conflict(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "학급 또는 학생 자료의 무결성 제약을 확인하세요.",
        ) from None


def _duplicate_numbers(numbers: list[int]) -> set[int]:
    seen: set[int] = set()
    duplicates: set[int] = set()
    for number in numbers:
        if number in seen:
            duplicates.add(number)
        else:
            seen.add(number)
    return duplicates


@router.post("/parse-roster")
def parse_roster(payload: RosterText) -> dict[str, list[dict[str, object]]]:
    students: list[dict[str, object]] = []
    numbers: list[int] = []
    for line_no, line in enumerate(payload.text.splitlines(), start=1):
        if not line.strip():
            continue
        if len(students) >= MAX_ROSTER_STUDENTS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "명렬표 인원이 처리 한도를 넘었습니다.",
            )
        match = ROSTER_LINE.fullmatch(line)
        if match is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{line_no}번째 줄을 읽을 수 없습니다. 번호와 이름을 공백이나 탭으로 나누세요.",
            )
        number = int(match.group(1))
        name = match.group(2).strip()
        if not name or len(name) > 50:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{line_no}번째 줄의 이름 길이가 올바르지 않습니다.",
            )
        numbers.append(number)
        students.append({"number": number, "name": name})

    if not students:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "명렬표에 학생이 없습니다.",
        )
    if _duplicate_numbers(numbers):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "명렬표에 중복된 학생 번호가 있습니다.",
        )
    return {"students": students}


@router.post("", response_model=ClassroomOut, status_code=status.HTTP_201_CREATED)
def create_classroom(
    payload: ClassroomIn,
    session: Session = Depends(get_session),
) -> Classroom:
    numbers = [student.number for student in payload.students]
    if _duplicate_numbers(numbers):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "학생 번호가 중복되었습니다.",
        )

    classroom = Classroom(name=payload.name)
    classroom.students = [
        Student(
            number=student.number,
            name=student.name,
            absent=student.absent,
        )
        for student in payload.students
    ]
    session.add(classroom)
    _commit_or_conflict(session)
    return classroom


@router.get("", response_model=list[ClassroomOut])
def list_classrooms(
    session: Session = Depends(get_session),
) -> list[Classroom]:
    return list(
        session.scalars(
            select(Classroom)
            .options(selectinload(Classroom.students))
            .order_by(Classroom.id.desc())
        ).all()
    )


@router.get("/{classroom_id}", response_model=ClassroomOut)
def get_classroom(
    classroom_id: Annotated[int, Path(ge=1)],
    session: Session = Depends(get_session),
) -> Classroom:
    classroom = session.scalar(
        select(Classroom)
        .options(selectinload(Classroom.students))
        .where(Classroom.id == classroom_id)
    )
    if classroom is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "학급을 찾을 수 없습니다.")
    return classroom


@router.patch(
    "/{classroom_id}/students/{student_id}",
    response_model=StudentOut,
)
def update_student(
    classroom_id: Annotated[int, Path(ge=1)],
    student_id: Annotated[int, Path(ge=1)],
    payload: StudentPatch,
    session: Session = Depends(get_session),
) -> Student:
    student = session.get(Student, student_id)
    if student is None or student.classroom_id != classroom_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "학생을 찾을 수 없습니다.")
    if payload.name is not None:
        student.name = payload.name
    if payload.absent is not None:
        student.absent = payload.absent
    _commit_or_conflict(session)
    return student
