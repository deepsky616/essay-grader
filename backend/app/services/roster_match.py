"""로컬 OCR 이름을 명렬표라는 닫힌 후보 집합에 안전하게 맞춘다."""

from dataclasses import dataclass
from enum import Enum
import unicodedata


MAX_DISTANCE_RATIO = 0.34
MAX_RAW_NAME_LENGTH = 200
MAX_NAME_LENGTH = 50
MAX_ROSTER_SIZE = 500


class MatchOutcome(str, Enum):
    MATCHED = "matched"
    AMBIGUOUS = "ambiguous"
    UNMATCHED = "unmatched"


@dataclass(frozen=True)
class NameMatch:
    outcome: MatchOutcome
    name: str | None
    distance: int

    def __post_init__(self) -> None:
        if self.outcome is MatchOutcome.MATCHED and self.name is None:
            raise ValueError("일치 결과에는 이름이 필요합니다.")
        if self.outcome is not MatchOutcome.MATCHED and self.name is not None:
            raise ValueError("불확실한 결과에는 이름을 넣을 수 없습니다.")
        if type(self.distance) is not int or self.distance < -1:
            raise ValueError("이름 편집 거리가 올바르지 않습니다.")


def _normalize(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    return "".join(
        character
        for character in normalized
        if not character.isspace() and unicodedata.category(character) != "Cf"
    )


def _edit_distance(left: str, right: str) -> int:
    if len(left) > len(right):
        left, right = right, left
    previous = list(range(len(left) + 1))
    for row, right_character in enumerate(right, start=1):
        current = [row]
        for column, left_character in enumerate(left, start=1):
            current.append(
                min(
                    current[column - 1] + 1,
                    previous[column] + 1,
                    previous[column - 1]
                    + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def _checked_roster(roster: list[str]) -> tuple[tuple[str, str], ...]:
    if type(roster) is not list:
        raise ValueError("명렬표는 이름 목록이어야 합니다.")
    if len(roster) > MAX_ROSTER_SIZE:
        raise ValueError("명렬표 인원이 처리 한도를 넘었습니다.")

    checked: list[tuple[str, str]] = []
    for name in roster:
        if type(name) is not str or len(name) > MAX_RAW_NAME_LENGTH:
            raise ValueError("명렬표 이름이 올바르지 않습니다.")
        normalized = _normalize(name)
        if not normalized or len(normalized) > MAX_NAME_LENGTH:
            raise ValueError("명렬표 이름이 올바르지 않습니다.")
        checked.append((name, normalized))
    return tuple(checked)


def match_name(raw: str, roster: list[str]) -> NameMatch:
    """유일하고 충분히 가까운 후보만 일치로 확정한다."""
    if type(raw) is not str or len(raw) > MAX_RAW_NAME_LENGTH:
        raise ValueError("인식한 이름이 올바르지 않습니다.")
    checked_roster = _checked_roster(roster)
    candidate = _normalize(raw)
    if len(candidate) > MAX_NAME_LENGTH:
        raise ValueError("인식한 이름이 올바르지 않습니다.")
    if not candidate or not checked_roster:
        return NameMatch(MatchOutcome.UNMATCHED, None, distance=-1)

    scored = sorted(
        (
            (_edit_distance(candidate, normalized), index, original, normalized)
            for index, (original, normalized) in enumerate(checked_roster)
        ),
        key=lambda item: (item[0], item[1]),
    )
    best_distance, _index, best_name, best_normalized = scored[0]
    limit = max(1, int(len(best_normalized) * MAX_DISTANCE_RATIO))
    if best_distance > limit:
        return NameMatch(
            MatchOutcome.UNMATCHED,
            None,
            distance=best_distance,
        )

    tied = sum(distance == best_distance for distance, *_rest in scored)
    if tied > 1:
        return NameMatch(
            MatchOutcome.AMBIGUOUS,
            None,
            distance=best_distance,
        )
    return NameMatch(
        MatchOutcome.MATCHED,
        best_name,
        distance=best_distance,
    )
