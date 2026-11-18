"""교사가 정한 경계값으로 총점의 성취수준을 판정한다."""

import math


LEVEL_KEYS = frozenset({"1", "2", "3"})


class LevelError(Exception):
    """성취수준을 안전하게 판정할 수 없을 때 발생한다."""


def _validate_cutoffs(cutoffs: dict[str, int]) -> None:
    if type(cutoffs) is not dict or set(cutoffs) != LEVEL_KEYS:
        raise LevelError("성취수준 컷오프는 1, 2, 3수준을 모두 포함해야 합니다.")
    if any(isinstance(value, bool) or not isinstance(value, int) for value in cutoffs.values()):
        raise LevelError("성취수준 컷오프는 정수여야 합니다.")
    if cutoffs["1"] != 0:
        raise LevelError("1수준 컷오프는 0점이어야 합니다.")
    if not cutoffs["3"] > cutoffs["2"] > cutoffs["1"]:
        raise LevelError("성취수준 컷오프는 3수준, 2수준, 1수준 차례로 낮아야 합니다.")


def determine_level(total: int, cutoffs: dict[str, int]) -> str:
    """총점이 속한 1, 2, 3수준 가운데 하나를 돌려준다."""
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise LevelError("총점은 0 이상의 정수여야 합니다.")
    _validate_cutoffs(cutoffs)

    for level in ("3", "2", "1"):
        if total >= cutoffs[level]:
            return level
    raise LevelError("총점에 해당하는 성취수준이 없습니다.")


def suggest_cutoffs(total_points: int) -> dict[str, int]:
    """교사가 검토할 출발값으로 85퍼센트와 45퍼센트 경계를 제안한다."""
    if (
        isinstance(total_points, bool)
        or not isinstance(total_points, int)
        or total_points < 2
    ):
        raise LevelError("총점은 세 수준을 나눌 수 있는 2 이상의 정수여야 합니다.")
    return {
        "3": math.ceil(total_points * 0.85),
        "2": math.ceil(total_points * 0.45),
        "1": 0,
    }
