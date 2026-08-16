from datetime import datetime

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)

from app.schemas.rubric import AchievementStandard


def _require_nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("공백만 있는 문자열은 사용할 수 없습니다.")
    return value


class AssessmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    subject: str = Field(min_length=1, max_length=50)
    grade: int = Field(ge=1, le=12, strict=True)
    total_points: int = Field(ge=1, strict=True)
    achievement_standards: list[AchievementStandard] = Field(default_factory=list)
    level_cutoffs: dict[str, StrictInt] = Field(default_factory=dict)

    @field_validator("title", "subject")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        return _require_nonblank(value)


class AssessmentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    subject: str | None = Field(default=None, min_length=1, max_length=50)
    grade: int | None = Field(default=None, ge=1, le=12, strict=True)
    total_points: int | None = Field(default=None, ge=1, strict=True)
    achievement_standards: list[AchievementStandard] | None = None
    level_cutoffs: dict[str, StrictInt] | None = None

    @field_validator("title", "subject")
    @classmethod
    def changed_text_must_not_be_blank(cls, value: str | None) -> str | None:
        return _require_nonblank(value) if value is not None else None

    @model_validator(mode="after")
    def require_at_least_one_non_null_change(self) -> "AssessmentUpdate":
        if not self.model_fields_set:
            raise ValueError("바꿀 평가 항목을 하나 이상 보내야 합니다.")
        if any(
            getattr(self, field_name) is None
            for field_name in self.model_fields_set
        ):
            raise ValueError("평가 항목을 null로 바꿀 수 없습니다.")
        return self


class AssessmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    subject: str
    grade: int
    total_points: int
    achievement_standards: list[AchievementStandard]
    level_cutoffs: dict[str, int]
    status: str
    created_at: datetime
