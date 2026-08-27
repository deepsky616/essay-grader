"""학생 한 명의 비식별 크롭을 문항별로 인식하고 채점한다."""

import re
from dataclasses import dataclass, field

from app.providers.base import LLMProvider
from app.providers.recognition import RecognitionProvider
from app.schemas.recognition import (
    RecognitionKind,
    RecognitionStatus,
    RecognizedResponse,
)
from app.schemas.rubric import AnswerSpec, ItemType, Rubric, RubricItem
from app.services.grader import ItemGrade, grade_item
from app.services.routing import RoutingInput, decide_route
from app.services.rubric_validator import validate_rubric


ANONYMOUS_TOKEN_PATTERN = re.compile(r"S-[0-9a-f]{8}", re.ASCII)
MAX_CROP_BYTES = 20 * 1024 * 1024


@dataclass
class SubmissionContext:
    submission_id: int
    anonymous_token: str | None
    assignment_status: str
    registration_quality: float
    crops: dict[int, bytes] = field(default_factory=dict)


@dataclass
class ScoredItem:
    item_no: int
    proposed_score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float
    route: str
    routing_reasons: list[str] = field(default_factory=list)
    part_scores: dict[str, int | None] = field(default_factory=dict)
    recognized_raw: str = ""


def _candidates_and_slots(
    spec: AnswerSpec,
    item_type: ItemType,
) -> tuple[list[str], int]:
    if item_type == ItemType.CLOSED_SHORT:
        candidates = [
            candidate
            for blank in spec.blanks
            for candidate in blank.all_accepted()
        ]
        return sorted(set(candidates)), len(spec.blanks)
    if item_type == ItemType.CLOSED_TABLE:
        candidates = [
            answer
            for column in spec.columns
            for answer in column.answers
        ]
        return sorted(set(candidates)), len(spec.columns)
    if item_type == ItemType.NUMERIC:
        return list(dict.fromkeys(spec.numeric_answers)), len(spec.numeric_answers)
    if item_type == ItemType.CHOICE:
        return list(dict.fromkeys(spec.choices)), 1
    return [], 0


def _recognition_error(kind: RecognitionKind) -> RecognizedResponse:
    return RecognizedResponse(
        kind=kind,
        status=RecognitionStatus.ERROR,
        confidence=0.0,
        note="인식 제공자 호출에 실패했습니다.",
    )


def _recognize_one(
    spec: AnswerSpec,
    item_type: ItemType,
    image: bytes,
    recognizer: RecognitionProvider,
    token: str,
) -> RecognizedResponse:
    if item_type == ItemType.DRAWING:
        return RecognizedResponse(
            kind=RecognitionKind.SKIPPED,
            status=RecognitionStatus.SKIPPED,
            confidence=0.0,
        )

    try:
        if item_type == ItemType.OPEN_TEXT:
            return recognizer.transcribe(image, anonymous_token=token)

        candidates, slots = _candidates_and_slots(spec, item_type)
        if not candidates or slots <= 0:
            return _recognition_error(RecognitionKind.CLASSIFY)
        return recognizer.classify(
            image,
            candidates,
            slot_count=slots,
            anonymous_token=token,
        )
    except Exception:  # noqa: BLE001 - 제공자 원문은 점수에 복제하지 않는다
        kind = (
            RecognitionKind.TRANSCRIBE
            if item_type == ItemType.OPEN_TEXT
            else RecognitionKind.CLASSIFY
        )
        return _recognition_error(kind)


def _recognize_item(
    item: RubricItem,
    image: bytes,
    recognizer: RecognitionProvider,
    token: str,
) -> dict[int, RecognizedResponse]:
    if item.type == ItemType.COMPOSITE:
        return {
            index: _recognize_one(part, part.type, image, recognizer, token)
            for index, part in enumerate(item.parts)
        }
    return {0: _recognize_one(item, item.type, image, recognizer, token)}


def _raw_text(responses: dict[int, RecognizedResponse]) -> str:
    parts: list[str] = []
    for index in sorted(responses):
        response = responses[index]
        text = (
            ", ".join(response.values)
            if response.kind == RecognitionKind.CLASSIFY
            else response.text
        )
        if text:
            parts.append(text)
    return " | ".join(parts)


def _to_scored(
    grade: ItemGrade,
    reasons: list[str],
    route: str,
    raw: str,
) -> ScoredItem:
    return ScoredItem(
        item_no=grade.item_no,
        proposed_score=grade.score,
        matched_criterion=grade.matched_criterion,
        evidence=grade.evidence,
        reason=grade.reason,
        confidence=grade.confidence,
        route=route,
        routing_reasons=list(reasons),
        part_scores=dict(grade.part_scores),
        recognized_raw=raw,
    )


def _manual_without_external(item: RubricItem, reason: str) -> ScoredItem:
    return ScoredItem(
        item_no=item.item_no,
        proposed_score=None,
        matched_criterion=None,
        evidence="",
        reason=reason,
        confidence=0.0,
        route="manual",
        routing_reasons=[reason],
    )


def grade_submission(
    rubric: Rubric,
    context: SubmissionContext,
    recognizer: RecognitionProvider,
    llm: LLMProvider,
    pii_terms: set[str] | None = None,
    confidence_threshold: float = 0.90,
    review_all: bool = False,
) -> list[ScoredItem]:
    errors = validate_rubric(rubric)
    if errors:
        raise ValueError("확정 루브릭 구조가 채점 계약을 만족하지 않습니다.")
    if type(context.submission_id) is not int or context.submission_id < 1:
        raise ValueError("제출 식별자가 올바르지 않습니다.")
    if type(context.crops) is not dict:
        raise ValueError("문항 크롭 묶음이 올바르지 않습니다.")

    items = sorted(rubric.items, key=lambda item: item.item_no)
    token = context.anonymous_token
    if token is None or not ANONYMOUS_TOKEN_PATTERN.fullmatch(token):
        return [
            _manual_without_external(item, "익명 토큰이 없어 외부 인식을 차단했습니다.")
            for item in items
        ]

    results: list[ScoredItem] = []
    for item in items:
        image = context.crops.get(item.item_no)
        needs_image = item.type != ItemType.DRAWING
        valid_image = (
            type(image) is bytes
            and 0 < len(image) <= MAX_CROP_BYTES
        )
        if needs_image and not valid_image:
            results.append(
                _manual_without_external(
                    item,
                    "응답 영역 크롭 이미지가 없거나 올바르지 않습니다.",
                )
            )
            continue

        responses = _recognize_item(
            item,
            image if valid_image else b"",
            recognizer,
            token,
        )
        grade = grade_item(
            item,
            responses,
            llm,
            pii_terms=pii_terms,
            anonymous_token=token,
        )
        decision = decide_route(
            RoutingInput(
                grade=grade,
                registration_quality=context.registration_quality,
                assignment_status=context.assignment_status,
                confidence_threshold=confidence_threshold,
                review_all=review_all,
            )
        )
        results.append(
            _to_scored(
                grade,
                decision.reasons,
                decision.route,
                _raw_text(responses),
            )
        )
    return results
