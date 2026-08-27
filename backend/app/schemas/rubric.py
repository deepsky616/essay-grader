"""루브릭 자료구조.

여기에는 형태만 정의한다. 배점 합계나 문항 번호 연속성 같은 업무 규칙은
app.services.rubric_validator 에 둔다. 둘을 섞으면 언어 모형 출력 파싱 실패와
업무 규칙 위반을 구분할 수 없게 된다.
"""

import re
from enum import Enum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    field_validator,
)


CONDITION_PATTERN = re.compile(
    r"^(all_correct|none_correct|set_exact|set_partial|llm|manual"
    r"|partial:\d+|partial:>=\d+)$"
)

LEVEL_KEYS = frozenset({"1", "2", "3"})
LevelKey = Literal["1", "2", "3"]
LevelDescriptions = dict[LevelKey, StrictStr]
LevelCutoffs = dict[LevelKey, StrictInt]


def _require_nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("공백만 있는 문자열은 사용할 수 없습니다.")
    return value


def _require_nonblank_list(values: list[str]) -> list[str]:
    if any(not value.strip() for value in values):
        raise ValueError("문자열 목록에 공백만 있는 값이 있습니다.")
    return values


class ItemType(str, Enum):
    CLOSED_SHORT = "closed_short"
    CLOSED_TABLE = "closed_table"
    NUMERIC = "numeric"
    CHOICE = "choice"
    DRAWING = "drawing"
    OPEN_TEXT = "open_text"
    COMPOSITE = "composite"


class Blank(BaseModel):
    """빈칸 하나의 정답 후보와 인정 표기 변형."""

    key: str
    answers: list[str] = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)

    @field_validator("key")
    @classmethod
    def key_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("answers", "aliases")
    @classmethod
    def candidates_must_not_be_blank(cls, values: list[str]) -> list[str]:
        return _require_nonblank_list(values)

    def all_accepted(self) -> list[str]:
        return [*self.answers, *self.aliases]


class TableColumn(BaseModel):
    """닫힌 표 유형의 열 하나와 해당 칸의 정답 기호 집합."""

    header: str
    answers: list[str] = Field(default_factory=list)

    @field_validator("header")
    @classmethod
    def header_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("answers")
    @classmethod
    def answers_must_not_be_blank(cls, values: list[str]) -> list[str]:
        return _require_nonblank_list(values)


class ScoringRule(BaseModel):
    score: int = Field(ge=0)
    condition: str
    criterion: str

    @field_validator("criterion")
    @classmethod
    def criterion_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("condition")
    @classmethod
    def condition_must_match_grammar(cls, value: str) -> str:
        if not CONDITION_PATTERN.fullmatch(value):
            raise ValueError(
                f"알 수 없는 조건식입니다: {value!r}. "
                "허용: all_correct, none_correct, set_exact, set_partial, "
                "llm, manual, partial:N, partial:>=N"
            )
        return value


class AnswerSpec(BaseModel):
    """유형별 정답 명세. 문항과 복합 문항 하위 파트가 공유한다."""

    blanks: list[Blank] = Field(default_factory=list)
    columns: list[TableColumn] = Field(default_factory=list)
    numeric_answers: list[str] = Field(default_factory=list)
    choices: list[str] = Field(default_factory=list)
    correct_choice: str | None = None

    @field_validator("numeric_answers", "choices")
    @classmethod
    def flat_candidates_must_not_be_blank(
        cls, values: list[str]
    ) -> list[str]:
        return _require_nonblank_list(values)

    @field_validator("correct_choice")
    @classmethod
    def correct_choice_must_not_be_blank(
        cls, value: str | None
    ) -> str | None:
        return _require_nonblank(value) if value is not None else None


class RubricPart(AnswerSpec):
    """복합 문항의 하위 파트."""

    part_id: str
    type: ItemType
    points: int = Field(ge=0)

    @field_validator("part_id")
    @classmethod
    def part_id_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)


class RubricItem(AnswerSpec):
    item_no: int = Field(ge=1)
    title: str
    points: int = Field(ge=0)
    standard_id: str | None = None
    type: ItemType
    parts: list[RubricPart] = Field(default_factory=list)
    scoring: list[ScoringRule] = Field(min_length=1)
    example_answer: str = ""

    @field_validator("title")
    @classmethod
    def title_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("standard_id")
    @classmethod
    def standard_id_must_not_be_blank(
        cls, value: str | None
    ) -> str | None:
        return _require_nonblank(value) if value is not None else None


class AchievementStandard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictStr
    item_range: Annotated[
        list[StrictInt], Field(min_length=2, max_length=2)
    ]
    core_standard: StrictStr
    levels: LevelDescriptions

    @field_validator("id", "core_standard")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)

    @field_validator("levels")
    @classmethod
    def levels_must_not_contain_blank_text(
        cls, values: LevelDescriptions
    ) -> LevelDescriptions:
        if any(not key.strip() or not value.strip() for key, value in values.items()):
            raise ValueError("성취수준에 공백만 있는 키나 설명이 있습니다.")
        return values


class AssessmentMeta(BaseModel):
    title: str
    subject: str
    grade: int
    total_points: int = Field(ge=1)

    @field_validator("title", "subject")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)


class Rubric(BaseModel):
    assessment: AssessmentMeta
    achievement_standards: list[AchievementStandard] = Field(default_factory=list)
    items: list[RubricItem] = Field(min_length=1)
    level_cutoffs: LevelCutoffs = Field(default_factory=dict)
