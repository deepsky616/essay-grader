"""설계 문서 7.5절의 서술 채점과 닫힌 출력 계약."""

import json
import math
from dataclasses import dataclass

from app.providers.base import LLMProvider, LLMRequest
from app.schemas.recognition import RecognitionKind, RecognizedResponse
from app.schemas.rubric import ItemType, RubricItem
from app.services.sanitize import mask_personal_names


MAX_RAW_RESPONSE_LENGTH = 100_000
REQUIRED_KEYS = frozenset(
    {
        "score",
        "matched_criterion",
        "evidence",
        "reasoning",
        "confidence",
    }
)

SYSTEM_PROMPT = """당신은 한국 초중등 논술형 평가의 서술 문항을 채점합니다.

반드시 아래 채점기준 가운데 하나를 원문 그대로 고르세요.
고른 기준의 정수 점수만 쓰고 중간 점수나 새 기준을 만들지 마세요.
근거에는 학생 답안에 실제로 있는 짧은 구절만 그대로 넣으세요.
맞춤법과 글씨체는 채점기준에 없으면 평가하지 마세요.

다음 다섯 칸만 가진 JSON 객체 하나를 출력하세요.
score, matched_criterion, evidence, reasoning, confidence
"""


@dataclass(frozen=True)
class LLMGradeOutcome:
    score: int | None
    matched_criterion: str | None
    evidence: str
    reason: str
    confidence: float = 0.0
    deferred: bool = False


def _deferred(reason: str) -> LLMGradeOutcome:
    return LLMGradeOutcome(
        score=None,
        matched_criterion=None,
        evidence="",
        reason=reason,
        deferred=True,
    )


def _build_prompt(item: RubricItem, answer_text: str) -> str:
    criteria = "\n".join(
        f"- {rule.score}점: {rule.criterion}" for rule in item.scoring
    )
    example = (
        f"\n예시답안\n{item.example_answer}\n"
        if item.example_answer.strip()
        else ""
    )
    return (
        f"문항\n{item.item_no}번. {item.title} (배점 {item.points}점)\n"
        f"\n채점기준\n{criteria}\n"
        f"{example}"
        f"\n학생 답안\n{answer_text}\n"
    )


def grade_open_text(
    item: RubricItem,
    response: RecognizedResponse,
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
    anonymous_token: str | None = None,
) -> LLMGradeOutcome:
    if (
        not response.is_usable
        or response.kind != RecognitionKind.TRANSCRIBE
        or not response.text.strip()
    ):
        return _deferred("전사 결과를 채점에 쓸 수 없습니다.")
    if item.type != ItemType.OPEN_TEXT or any(
        rule.condition != "llm" for rule in item.scoring
    ):
        return _deferred("서술 채점용 루브릭이 올바르지 않습니다.")

    masked_text, _ = mask_personal_names(response.text, pii_terms or set())
    user_text = _build_prompt(item, masked_text)

    try:
        llm_response = LLMProvider.complete(
            provider,
            LLMRequest(
                system=SYSTEM_PROMPT,
                user_text=user_text,
                purpose="grade_open_text",
                anonymous_token=anonymous_token,
            ),
        )
    except Exception:  # noqa: BLE001 - 제공자 세부 내용은 결과에 남기지 않는다
        return _deferred("서술 채점 외부 호출에 실패했습니다.")

    return _validate(item, masked_text, llm_response.text)


def _reject_json_constant(_value: str) -> None:
    raise ValueError("유한한 JSON 수가 아닙니다.")


def _validate(
    item: RubricItem,
    answer_text: str,
    raw: str,
) -> LLMGradeOutcome:
    if not isinstance(raw, str) or len(raw) > MAX_RAW_RESPONSE_LENGTH:
        return _deferred("채점 응답 형식이 올바르지 않습니다.")
    try:
        payload = json.loads(raw, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, ValueError, TypeError):
        return _deferred("채점 응답 형식이 올바르지 않습니다.")
    if type(payload) is not dict or set(payload) != REQUIRED_KEYS:
        return _deferred("채점 응답 형식이 올바르지 않습니다.")

    score = payload["score"]
    criterion_value = payload["matched_criterion"]
    evidence_value = payload["evidence"]
    reasoning_value = payload["reasoning"]
    confidence_value = payload["confidence"]

    if type(score) is not int:
        return _deferred("루브릭에 없는 배점입니다.")
    allowed_scores = {rule.score for rule in item.scoring}
    if score not in allowed_scores:
        return _deferred("루브릭에 없는 배점입니다.")

    if not isinstance(criterion_value, str):
        return _deferred("루브릭에 없는 채점기준입니다.")
    criterion = criterion_value.strip()
    allowed_criteria = {rule.criterion.strip() for rule in item.scoring}
    if criterion not in allowed_criteria:
        return _deferred("루브릭에 없는 채점기준입니다.")
    allowed_pairs = {
        (rule.score, rule.criterion.strip()) for rule in item.scoring
    }
    if (score, criterion) not in allowed_pairs:
        return _deferred("점수와 채점기준이 일치하지 않습니다.")

    if not isinstance(evidence_value, str) or not evidence_value.strip():
        return _deferred("채점 근거가 비어 있습니다.")
    evidence = evidence_value.strip()
    collapsed_answer = " ".join(answer_text.split())
    collapsed_evidence = " ".join(evidence.split())
    if collapsed_evidence not in collapsed_answer:
        return _deferred("채점 근거를 학생 답안에서 찾을 수 없습니다.")

    if not isinstance(reasoning_value, str) or not reasoning_value.strip():
        return _deferred("채점 판단 설명이 비어 있습니다.")
    reasoning = reasoning_value.strip()
    if len(evidence) > 4_000 or len(reasoning) > 4_000:
        return _deferred("채점 응답 형식이 올바르지 않습니다.")

    if (
        isinstance(confidence_value, bool)
        or not isinstance(confidence_value, (int, float))
        or not math.isfinite(float(confidence_value))
        or not 0.0 <= float(confidence_value) <= 1.0
    ):
        return _deferred("채점 신뢰도가 올바르지 않습니다.")

    return LLMGradeOutcome(
        score=score,
        matched_criterion=criterion,
        evidence=evidence,
        reason=reasoning,
        confidence=float(confidence_value),
    )
