"""루브릭 조건식의 제한된 문법을 결정론적으로 평가한다."""

import re
from dataclasses import dataclass
from enum import Enum


PARTIAL_EXACT = re.compile(r"^partial:(\d+)$")
PARTIAL_AT_LEAST = re.compile(r"^partial:>=(\d+)$")


class SetMatch(str, Enum):
    EXACT = "exact"
    PARTIAL = "partial"
    NONE = "none"


@dataclass(frozen=True)
class ConditionContext:
    correct_count: int
    total_count: int
    set_match: SetMatch = SetMatch.NONE

    def __post_init__(self) -> None:
        if (
            isinstance(self.correct_count, bool)
            or isinstance(self.total_count, bool)
            or not isinstance(self.correct_count, int)
            or not isinstance(self.total_count, int)
            or self.correct_count < 0
            or self.total_count < 0
            or self.correct_count > self.total_count
        ):
            raise ValueError("정답 개수와 전체 개수가 올바르지 않습니다.")


def evaluate_condition(condition: str, context: ConditionContext) -> bool:
    if condition == "all_correct":
        return (
            context.total_count > 0
            and context.correct_count == context.total_count
        )
    if condition == "none_correct":
        return context.total_count > 0 and context.correct_count == 0
    if condition == "set_exact":
        return context.set_match == SetMatch.EXACT
    if condition == "set_partial":
        return context.set_match == SetMatch.PARTIAL

    at_least = PARTIAL_AT_LEAST.fullmatch(condition)
    if at_least:
        return context.correct_count >= int(at_least.group(1))

    exact = PARTIAL_EXACT.fullmatch(condition)
    if exact:
        return context.correct_count == int(exact.group(1))

    if condition in {"llm", "manual"}:
        raise ValueError(
            f"{condition!r} 조건은 자동 평가할 수 없습니다."
        )

    raise ValueError(f"알 수 없는 조건식입니다: {condition!r}")
