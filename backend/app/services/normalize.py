"""설계 문서 7.4절의 값 정규화와 닫힌 후보 집합 맞추기."""

import re
import unicodedata
from dataclasses import dataclass


NUMERIC_UNIT_PATTERN = re.compile(
    r"^([+-]?\d[\d,.]*)(?:원|퍼센트|프로|%|개|점)$"
)
THOUSANDS_PATTERN = re.compile(r"^\d{1,3}([,.])\d{3}(?:\1\d{3})*$")
MAX_SNAP_RATIO = 0.34


def normalize_value(raw: str) -> str:
    """표기 차이만 지운 비교용 문자열을 만든다."""

    if not raw:
        return ""

    text = unicodedata.normalize("NFKC", raw)
    text = "".join(text.split())

    numeric_with_unit = NUMERIC_UNIT_PATTERN.fullmatch(text)
    if numeric_with_unit:
        text = numeric_with_unit.group(1)

    if THOUSANDS_PATTERN.fullmatch(text):
        return text.replace(",", "").replace(".", "")

    return text.replace(",", "")


@dataclass(frozen=True)
class SnapResult:
    matched: str | None
    distance: int
    ambiguous: bool = False


def _edit_distance(left: str, right: str) -> int:
    """삽입, 삭제, 바꾸기를 각각 한 번으로 세는 편집 거리."""

    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1]
                    + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def snap_to_candidates(
    raw: str,
    candidates: list[str],
    aliases: dict[str, list[str]] | None = None,
) -> SnapResult:
    """유일하고 가까운 후보만 돌려주고 나머지는 추측하지 않는다."""

    normalized = normalize_value(raw)
    if not normalized or not candidates:
        return SnapResult(None, distance=-1)

    forms: set[tuple[str, str]] = set()
    for candidate in candidates:
        candidate_form = normalize_value(candidate)
        if candidate_form:
            forms.add((candidate_form, candidate))
        for alias in (aliases or {}).get(candidate, []):
            alias_form = normalize_value(alias)
            if alias_form:
                forms.add((alias_form, candidate))

    if not forms:
        return SnapResult(None, distance=-1)

    scored = sorted(
        (
            (_edit_distance(normalized, form), candidate, form)
            for form, candidate in forms
        ),
        key=lambda entry: (entry[0], entry[1], entry[2]),
    )
    best_distance = scored[0][0]
    best_entries = [entry for entry in scored if entry[0] == best_distance]
    best_candidates = {entry[1] for entry in best_entries}
    if len(best_candidates) != 1:
        return SnapResult(None, distance=best_distance, ambiguous=True)

    best_candidate = next(iter(best_candidates))
    best_form_length = max(len(entry[2]) for entry in best_entries)
    limit = max(1, int(best_form_length * MAX_SNAP_RATIO))
    if best_distance > limit:
        return SnapResult(None, distance=best_distance)

    return SnapResult(best_candidate, distance=best_distance)
