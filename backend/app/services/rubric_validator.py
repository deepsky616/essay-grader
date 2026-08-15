"""루브릭 구조 규칙 검증.

여기서 반환하는 ``ValidationError`` 는 고치지 않으면 채점을 시작할 수 없는
문제다. 확인이 필요하지만 진행은 가능한 문제는 별도 경고 검증기가 다룬다.
"""

from dataclasses import dataclass

from app.schemas.rubric import AnswerSpec, ItemType, Rubric, RubricItem


_DETERMINISTIC_CONDITIONS = frozenset(
    {"all_correct", "none_correct", "partial"}
)
_ALLOWED_CONDITIONS = {
    ItemType.CLOSED_SHORT: _DETERMINISTIC_CONDITIONS,
    ItemType.CLOSED_TABLE: frozenset({"set_exact", "set_partial"}),
    ItemType.NUMERIC: _DETERMINISTIC_CONDITIONS,
    ItemType.CHOICE: _DETERMINISTIC_CONDITIONS,
    ItemType.DRAWING: frozenset({"manual"}),
    ItemType.OPEN_TEXT: frozenset({"llm"}),
    ItemType.COMPOSITE: _DETERMINISTIC_CONDITIONS,
}


@dataclass(frozen=True)
class ValidationError:
    """루브릭의 한 구조 규칙 위반."""

    path: str
    message: str


def _condition_is_allowed(item_type: ItemType, condition: str) -> bool:
    allowed_conditions = _ALLOWED_CONDITIONS[item_type]
    return condition in allowed_conditions or (
        "partial" in allowed_conditions and condition.startswith("partial:")
    )


def _validate_answer_spec(
    spec: AnswerSpec, item_type: ItemType, path: str, label: str
) -> list[ValidationError]:
    errors: list[ValidationError] = []
    if item_type == ItemType.CLOSED_SHORT:
        if not spec.blanks:
            errors.append(ValidationError(path, f"{label}: 정답 후보가 비어 있습니다."))
    elif item_type == ItemType.CLOSED_TABLE:
        if not spec.columns:
            errors.append(ValidationError(path, f"{label}: 정답 후보가 비어 있습니다."))
        for column in spec.columns:
            if not column.answers:
                errors.append(
                    ValidationError(
                        path, f"{label}: {column.header} 열의 정답 후보가 비어 있습니다."
                    )
                )
    elif item_type == ItemType.NUMERIC:
        if not spec.numeric_answers:
            errors.append(ValidationError(path, f"{label}: 정답 후보가 비어 있습니다."))
    elif item_type == ItemType.CHOICE:
        if not spec.choices or spec.correct_choice is None:
            errors.append(ValidationError(path, f"{label}: 정답 후보가 비어 있습니다."))
        elif spec.correct_choice not in spec.choices:
            errors.append(
                ValidationError(path, f"{label}: 정답 선택지가 선택지 후보에 없습니다.")
            )
    return errors


def _validate_item(
    item: RubricItem, standard_ranges: dict[str, tuple[int, int]]
) -> list[ValidationError]:
    errors: list[ValidationError] = []
    path = f"items[{item.item_no}]"
    scores = [rule.score for rule in item.scoring]

    if item.points not in scores:
        errors.append(
            ValidationError(path, f"{item.item_no}번: 만점({item.points}점) 채점기준이 없습니다.")
        )
    if 0 not in scores:
        errors.append(ValidationError(path, f"{item.item_no}번: 0점 채점기준이 없습니다."))
    for score in scores:
        if score > item.points:
            errors.append(
                ValidationError(
                    path,
                    f"{item.item_no}번: 채점기준 {score}점이 문항 배점을 초과합니다. "
                    f"문항 배점은 {item.points}점입니다.",
                )
            )

    for rule in item.scoring:
        if not _condition_is_allowed(item.type, rule.condition):
            errors.append(
                ValidationError(
                    path,
                    f"{item.item_no}번({item.type.value}): 조건식 {rule.condition!r}은 "
                    "이 문항 유형에 사용할 수 없습니다.",
                )
            )

    errors.extend(
        _validate_answer_spec(item, item.type, path, f"{item.item_no}번({item.type.value})")
    )

    if item.type == ItemType.COMPOSITE:
        if not item.parts:
            errors.append(
                ValidationError(path, f"{item.item_no}번: composite 문항에 하위 파트가 없습니다.")
            )
        else:
            part_total = sum(part.points for part in item.parts)
            if part_total != item.points:
                errors.append(
                    ValidationError(
                        path,
                        f"{item.item_no}번: 하위 파트 배점 합계({part_total}점)가 "
                        f"문항 배점({item.points}점)과 다릅니다.",
                    )
                )
            for part in item.parts:
                errors.extend(
                    _validate_answer_spec(
                        part,
                        part.type,
                        f"{path}.parts[{part.part_id}]",
                        f"{item.item_no}번 파트 {part.part_id}",
                    )
                )

    if item.standard_id is not None:
        standard_range = standard_ranges.get(item.standard_id)
        if standard_range is None:
            errors.append(
                ValidationError(
                    path,
                    f"{item.item_no}번: 알 수 없는 성취기준 id {item.standard_id!r} 입니다.",
                )
            )
        elif not standard_range[0] <= item.item_no <= standard_range[1]:
            errors.append(
                ValidationError(
                    path,
                    f"{item.item_no}번: 성취기준 {item.standard_id!r}의 문항 범위 "
                    f"{list(standard_range)} 밖입니다.",
                )
            )

    return errors


def _validate_cutoffs(rubric: Rubric) -> list[ValidationError]:
    if not rubric.level_cutoffs:
        return []

    try:
        pairs = sorted(
            ((int(level), cut) for level, cut in rubric.level_cutoffs.items()),
            reverse=True,
        )
    except ValueError:
        return [ValidationError("level_cutoffs", "성취수준 키는 정수 문자열이어야 합니다.")]

    errors: list[ValidationError] = []
    total = rubric.assessment.total_points
    previous_cut: int | None = None
    for level, cut in pairs:
        if cut < 0 or cut > total:
            errors.append(
                ValidationError(
                    "level_cutoffs", f"{level}수준 컷오프 {cut}점이 총점 범위를 벗어납니다."
                )
            )
        if previous_cut is not None and cut >= previous_cut:
            errors.append(
                ValidationError(
                    "level_cutoffs",
                    f"성취수준 컷오프가 수준이 낮아질수록 작아져야 합니다. "
                    f"{level}수준({cut}점)이 상위 수준({previous_cut}점) 이상입니다.",
                )
            )
        previous_cut = cut
    return errors


def validate_rubric(rubric: Rubric) -> list[ValidationError]:
    """채점을 막아야 할 루브릭 구조 오류를 모두 반환한다."""

    errors: list[ValidationError] = []
    points_sum = sum(item.points for item in rubric.items)
    if points_sum != rubric.assessment.total_points:
        errors.append(
            ValidationError(
                "items",
                f"문항 배점 합계({points_sum}점)가 총점({rubric.assessment.total_points}점)과 다릅니다.",
            )
        )

    numbers = [item.item_no for item in rubric.items]
    if sorted(numbers) != list(range(1, len(numbers) + 1)):
        errors.append(
            ValidationError("items", f"문항 번호가 1부터 연속되지 않습니다: {sorted(numbers)}")
        )

    standard_ranges = {
        standard.id: (standard.item_range[0], standard.item_range[1])
        for standard in rubric.achievement_standards
    }
    for item in rubric.items:
        errors.extend(_validate_item(item, standard_ranges))

    errors.extend(_validate_cutoffs(rubric))
    return errors
