"""루브릭 구조 규칙 검증.

여기서 반환하는 ``ValidationError`` 는 고치지 않으면 채점을 시작할 수 없는
문제다. 확인이 필요하지만 진행은 가능한 문제는 별도 경고 검증기가 다룬다.
"""

from dataclasses import dataclass

from app.schemas.rubric import AnswerSpec, ItemType, Rubric, RubricItem


_REQUIRES_ANSWERS = {
    ItemType.CLOSED_SHORT,
    ItemType.CLOSED_TABLE,
    ItemType.NUMERIC,
    ItemType.CHOICE,
}


@dataclass(frozen=True)
class ValidationError:
    """루브릭의 한 구조 규칙 위반."""

    path: str
    message: str


def _has_answers(spec: AnswerSpec, item_type: ItemType) -> bool:
    if item_type == ItemType.CLOSED_SHORT:
        return bool(spec.blanks)
    if item_type == ItemType.CLOSED_TABLE:
        return bool(spec.columns)
    if item_type == ItemType.NUMERIC:
        return bool(spec.numeric_answers)
    if item_type == ItemType.CHOICE:
        return bool(spec.choices) and spec.correct_choice is not None
    return True


def _validate_item(item: RubricItem, standard_ids: set[str]) -> list[ValidationError]:
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

    if item.type in _REQUIRES_ANSWERS and not _has_answers(item, item.type):
        errors.append(
            ValidationError(
                path,
                f"{item.item_no}번({item.type.value}): 정답 후보가 비어 있습니다. "
                "폐집합 매칭을 쓸 수 없어 자동 채점이 불가능합니다.",
            )
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
                if part.type in _REQUIRES_ANSWERS and not _has_answers(part, part.type):
                    errors.append(
                        ValidationError(
                            f"{path}.parts[{part.part_id}]",
                            f"{item.item_no}번 파트 {part.part_id}: 정답 후보가 비어 있습니다.",
                        )
                    )

    if item.standard_id is not None and item.standard_id not in standard_ids:
        errors.append(
            ValidationError(
                path,
                f"{item.item_no}번: 알 수 없는 성취기준 id {item.standard_id!r} 입니다.",
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

    standard_ids = {standard.id for standard in rubric.achievement_standards}
    for item in rubric.items:
        errors.extend(_validate_item(item, standard_ids))

    errors.extend(_validate_cutoffs(rubric))
    return errors
