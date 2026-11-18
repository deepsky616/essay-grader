"""닫힌 정답 문항을 외부 호출 없이 같은 규칙으로 채점한다."""

from dataclasses import dataclass

from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import AnswerSpec, ItemType, RubricItem
from app.services.conditions import (
    ConditionContext,
    SetMatch,
    evaluate_condition,
)
from app.services.normalize import normalize_value, snap_to_candidates


TABLE_CELL_SEPARATOR = "|"


@dataclass(frozen=True)
class GradeOutcome:
    score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    deferred: bool = False


def _grade_blanks(
    item: AnswerSpec,
    response: RecognizedResponse,
) -> ConditionContext:
    correct = 0
    for index, blank in enumerate(item.blanks):
        raw = response.values[index] if index < len(response.values) else ""
        aliases = {blank.answers[0]: blank.aliases} if blank.answers else None
        if snap_to_candidates(raw, blank.answers, aliases=aliases).matched is not None:
            correct += 1
    return ConditionContext(correct_count=correct, total_count=len(item.blanks))


def _grade_numeric(
    item: AnswerSpec,
    response: RecognizedResponse,
) -> ConditionContext:
    expected = [normalize_value(value) for value in item.numeric_answers]
    correct = 0
    for index, target in enumerate(expected):
        raw = response.values[index] if index < len(response.values) else ""
        if normalize_value(raw) == target:
            correct += 1
    return ConditionContext(correct_count=correct, total_count=len(expected))


def _grade_choice(
    item: AnswerSpec,
    response: RecognizedResponse,
) -> ConditionContext:
    chosen = response.values[0] if len(response.values) == 1 else ""
    snap = snap_to_candidates(chosen, item.choices)
    correct = int(
        snap.matched is not None
        and item.correct_choice is not None
        and normalize_value(snap.matched)
        == normalize_value(item.correct_choice)
    )
    return ConditionContext(correct_count=correct, total_count=1)


def _grade_table(
    item: AnswerSpec,
    response: RecognizedResponse,
) -> ConditionContext:
    exact_columns = 0
    any_overlap = False

    for index, column in enumerate(item.columns):
        raw = response.values[index] if index < len(response.values) else ""
        written = {
            normalized
            for part in raw.split(TABLE_CELL_SEPARATOR)
            if (normalized := normalize_value(part))
        }
        expected = {
            normalized
            for answer in column.answers
            if (normalized := normalize_value(answer))
        }

        if written == expected:
            exact_columns += 1
        if written & expected:
            any_overlap = True

    has_extra_columns = len(response.values) > len(item.columns)
    if (
        exact_columns == len(item.columns)
        and item.columns
        and not has_extra_columns
    ):
        set_match = SetMatch.EXACT
    elif any_overlap:
        set_match = SetMatch.PARTIAL
    else:
        set_match = SetMatch.NONE

    return ConditionContext(
        correct_count=exact_columns,
        total_count=len(item.columns),
        set_match=set_match,
    )


_HANDLERS = {
    ItemType.CLOSED_SHORT: _grade_blanks,
    ItemType.NUMERIC: _grade_numeric,
    ItemType.CHOICE: _grade_choice,
    ItemType.CLOSED_TABLE: _grade_table,
}


def _expected_count(spec: AnswerSpec, item_type: ItemType) -> int:
    if item_type == ItemType.CLOSED_SHORT:
        return len(spec.blanks)
    if item_type == ItemType.NUMERIC:
        return len(spec.numeric_answers)
    if item_type == ItemType.CHOICE:
        return 1
    if item_type == ItemType.CLOSED_TABLE:
        return len(spec.columns)
    return 0


def evaluate_answers(
    spec: AnswerSpec,
    item_type: ItemType,
    response: RecognizedResponse,
) -> ConditionContext:
    handler = _HANDLERS.get(item_type)
    if handler is None:
        raise ValueError(
            f"{item_type.value} 유형은 결정론 채점 대상이 아닙니다."
        )
    if response.kind != RecognitionKind.CLASSIFY:
        raise ValueError("결정론 채점에는 후보 분류 인식 결과가 필요합니다.")
    if response.status == RecognitionStatus.NONE_OF_ABOVE:
        return ConditionContext(
            correct_count=0,
            total_count=max(1, _expected_count(spec, item_type)),
        )
    return handler(spec, response)


def is_correct(
    spec: AnswerSpec,
    item_type: ItemType,
    response: RecognizedResponse,
) -> bool:
    if not response.is_usable or response.kind != RecognitionKind.CLASSIFY:
        return False
    context = evaluate_answers(spec, item_type, response)
    return (
        context.total_count > 0
        and context.correct_count == context.total_count
    )


def grade_deterministic(
    item: RubricItem,
    response: RecognizedResponse,
) -> GradeOutcome:
    if not response.is_usable:
        return GradeOutcome(
            score=None,
            matched_criterion=None,
            evidence="",
            reason=(
                "인식 결과를 채점에 쓸 수 없습니다. "
                "판독 불가이거나 인식 호출이 실패했습니다."
            ),
            deferred=True,
        )
    if response.kind != RecognitionKind.CLASSIFY:
        return GradeOutcome(
            score=None,
            matched_criterion=None,
            evidence="",
            reason="결정론 채점에는 후보 분류 인식 결과가 필요합니다.",
            deferred=True,
        )

    context = evaluate_answers(item, item.type, response)
    best: tuple[int, str] | None = None
    for rule in item.scoring:
        if evaluate_condition(rule.condition, context):
            if best is None or rule.score > best[0]:
                best = (rule.score, rule.criterion)

    evidence = ", ".join(response.values) or "(빈 응답)"
    if best is None:
        return GradeOutcome(
            score=None,
            matched_criterion=None,
            evidence=evidence,
            reason=(
                "인식 결과가 어떤 채점기준에도 해당하지 않습니다 "
                f"(정답 {context.correct_count}/{context.total_count})."
            ),
            deferred=True,
        )

    score, criterion = best
    return GradeOutcome(
        score=score,
        matched_criterion=criterion,
        evidence=evidence,
        reason=(
            f"정답 {context.correct_count}/{context.total_count}에서 "
            f"{score}점 기준을 적용했습니다."
        ),
    )
