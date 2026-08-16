"""인식 결과만 받아 문항 유형별 채점 길을 고른다."""

from dataclasses import dataclass, field

from app.providers.base import LLMProvider
from app.schemas.recognition import RecognizedResponse
from app.schemas.rubric import ItemType, RubricItem
from app.services.conditions import ConditionContext, evaluate_condition
from app.services.deterministic_grader import grade_deterministic, is_correct
from app.services.llm_grader import grade_open_text


AUTO_TYPES = {
    ItemType.CLOSED_SHORT,
    ItemType.CLOSED_TABLE,
    ItemType.NUMERIC,
    ItemType.CHOICE,
}


@dataclass
class ItemGrade:
    item_no: int
    score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float
    route: str
    part_scores: dict[str, int | None] = field(default_factory=dict)


def _manual(
    item: RubricItem,
    reason: str,
    *,
    evidence: str = "",
    confidence: float = 0.0,
    part_scores: dict[str, int | None] | None = None,
) -> ItemGrade:
    return ItemGrade(
        item_no=item.item_no,
        score=None,
        matched_criterion=None,
        evidence=evidence,
        reason=reason,
        confidence=confidence,
        route="manual",
        part_scores=part_scores or {},
    )


def _grade_composite(
    item: RubricItem,
    responses: dict[int, RecognizedResponse],
) -> ItemGrade:
    correct = 0
    judged = 0
    evidences: list[str] = []
    confidences: list[float] = []
    part_scores: dict[str, int | None] = {}
    has_unjudgeable = False

    for index, part in enumerate(item.parts):
        response = responses.get(index)

        if part.type in {ItemType.OPEN_TEXT, ItemType.DRAWING}:
            has_unjudgeable = True
            part_scores[part.part_id] = None
            label = "서술" if part.type == ItemType.OPEN_TEXT else "작도"
            text = response.text if response is not None else ""
            evidences.append(
                f"{part.part_id}({label}, 판정 안 함): {text or '—'}"
            )
            continue

        if response is None or not response.is_usable:
            has_unjudgeable = True
            part_scores[part.part_id] = None
            evidences.append(f"{part.part_id}: 인식 결과를 쓸 수 없음")
            continue

        judged += 1
        confidences.append(response.confidence)
        ok = is_correct(part, part.type, response)
        if ok:
            correct += 1
        part_scores[part.part_id] = part.points if ok else 0
        evidences.append(
            f"{part.part_id}: {', '.join(response.values) or '(빈 응답)'} "
            f"→ {'정답' if ok else '오답'}"
        )

    evidence = " / ".join(evidences)
    confidence = min(confidences) if confidences else 0.0

    if has_unjudgeable:
        return _manual(
            item,
            (
                "서술, 작도 또는 판독 불가 파트가 포함된 복합 문항입니다. "
                f"자동 판정 가능한 파트는 {correct}/{judged} 정답입니다."
            ),
            evidence=evidence,
            confidence=confidence,
            part_scores=part_scores,
        )

    context = ConditionContext(
        correct_count=correct,
        total_count=len(item.parts),
    )
    best: tuple[int, str] | None = None
    for rule in item.scoring:
        if rule.condition in {"llm", "manual"}:
            continue
        if evaluate_condition(rule.condition, context):
            if best is None or rule.score > best[0]:
                best = (rule.score, rule.criterion)

    if best is None:
        return _manual(
            item,
            "하위 파트 정답 수에 맞는 채점기준이 없습니다.",
            evidence=evidence,
            confidence=confidence,
            part_scores=part_scores,
        )

    score, criterion = best
    return ItemGrade(
        item_no=item.item_no,
        score=score,
        matched_criterion=criterion,
        evidence=evidence,
        reason=(
            f"하위 파트 정답 {correct}/{len(item.parts)}에서 "
            f"{score}점 기준을 적용했습니다."
        ),
        confidence=confidence,
        route="auto",
        part_scores=part_scores,
    )


def grade_item(
    item: RubricItem,
    responses: dict[int, RecognizedResponse],
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
    anonymous_token: str | None = None,
) -> ItemGrade:
    """단일 문항은 0번, 복합 문항은 파트 차례를 키로 받는다."""

    expected_indexes = (
        set(range(len(item.parts)))
        if item.type == ItemType.COMPOSITE
        else {0}
    )
    if not set(responses).issubset(expected_indexes):
        return _manual(item, "예상하지 않은 인식 결과 번호가 있습니다.")

    if item.type == ItemType.DRAWING:
        return _manual(
            item,
            "작도 문항은 자동 인식과 채점을 하지 않고 교사가 배점합니다.",
        )

    if item.type == ItemType.COMPOSITE:
        return _grade_composite(item, responses)

    response = responses.get(0)
    if response is None:
        return _manual(item, "문항 인식 결과가 없습니다.")

    if item.type == ItemType.OPEN_TEXT:
        outcome = grade_open_text(
            item,
            response,
            provider,
            pii_terms=pii_terms,
            anonymous_token=anonymous_token,
        )
        if outcome.deferred:
            return _manual(item, outcome.reason)
        return ItemGrade(
            item_no=item.item_no,
            score=outcome.score,
            matched_criterion=outcome.matched_criterion,
            evidence=outcome.evidence,
            reason=outcome.reason,
            confidence=outcome.confidence,
            route="manual",
        )

    outcome = grade_deterministic(item, response)
    if outcome.deferred:
        return _manual(item, outcome.reason)

    return ItemGrade(
        item_no=item.item_no,
        score=outcome.score,
        matched_criterion=outcome.matched_criterion,
        evidence=outcome.evidence,
        reason=outcome.reason,
        confidence=response.confidence,
        route="auto" if item.type in AUTO_TYPES else "manual",
    )
