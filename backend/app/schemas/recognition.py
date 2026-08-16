"""인식기와 채점기 사이의 제한된 값 경계."""

from enum import Enum
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, StrictStr, model_validator


class RecognitionKind(str, Enum):
    CLASSIFY = "classify"
    TRANSCRIBE = "transcribe"
    SKIPPED = "skipped"


class RecognitionStatus(str, Enum):
    OK = "ok"
    NONE_OF_ABOVE = "none_of_above"
    UNREADABLE = "unreadable"
    SKIPPED = "skipped"
    ERROR = "error"


class RecognizedResponse(BaseModel):
    """이미지나 학생 식별정보를 담지 않는 인식 결과."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: RecognitionKind
    status: RecognitionStatus
    values: list[StrictStr] = Field(default_factory=list, max_length=100)
    text: StrictStr = Field(default="", max_length=20_000)
    confidence: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)
    note: StrictStr = Field(default="", max_length=500)

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if self.kind == RecognitionKind.SKIPPED:
            if self.status != RecognitionStatus.SKIPPED:
                raise ValueError("인식 종류와 상태가 맞지 않습니다.")
        elif self.status == RecognitionStatus.SKIPPED:
            raise ValueError("인식 종류와 상태가 맞지 않습니다.")

        if (
            self.kind != RecognitionKind.CLASSIFY
            and self.status == RecognitionStatus.NONE_OF_ABOVE
        ):
            raise ValueError("인식 종류와 상태가 맞지 않습니다.")

        if self.status == RecognitionStatus.OK:
            if self.kind == RecognitionKind.CLASSIFY and not self.values:
                raise ValueError("분류 성공에는 후보 값이 필요합니다.")
            if self.kind == RecognitionKind.TRANSCRIBE and not self.text.strip():
                raise ValueError("전사 성공에는 전사 글이 필요합니다.")
        elif self.values or self.text:
            raise ValueError("성공하지 않은 인식 결과에는 인식 내용을 넣을 수 없습니다.")

        if self.kind == RecognitionKind.CLASSIFY and self.text:
            raise ValueError("분류 결과에는 전사 글을 넣을 수 없습니다.")
        if self.kind == RecognitionKind.TRANSCRIBE and self.values:
            raise ValueError("전사 결과에는 후보 값을 넣을 수 없습니다.")
        if any(not value.strip() for value in self.values):
            raise ValueError("후보 값은 공백일 수 없습니다.")
        return self

    @property
    def is_usable(self) -> bool:
        return self.status in {
            RecognitionStatus.OK,
            RecognitionStatus.NONE_OF_ABOVE,
        }
