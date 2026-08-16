"""익명 점수와 루브릭만 외부로 보내 학생용 피드백 문장을 만든다."""

import json
from dataclasses import dataclass, field
from typing import Any

from app.providers.base import LLMProvider, LLMRequest
from app.services.feedback_builder import FeedbackContext
from app.services.sanitize import mask_personal_names


MAX_RAW_RESPONSE_LENGTH = 100_000
MAX_COMMENT_LENGTH = 4_000
MAX_SECTION_LENGTH = 10_000
REQUIRED_KEYS = frozenset({"item_comments", "summary", "next_step"})
COMMENT_KEYS = frozenset({"item_no", "comment"})

SYSTEM_PROMPT = """당신은 초중등 교사가 학생에게 줄 평가 피드백을 씁니다.

반드시 다음을 지키세요.
1. 이름을 쓰지 말고 주어는 학생으로 쓰세요.
2. 대상 학년에 맞는 짧고 쉬운 문장을 쓰세요.
3. 지적보다 다음에 할 수 있는 구체적인 행동을 알려 주세요.
4. 받은 채점 기준과 예시 답안 밖의 사실을 만들지 마세요.
5. 문항별 설명은 한두 문장으로 쓰고 만점 문항도 잘한 점을 짚어 주세요.

다음 세 칸만 가진 JSON 객체 하나를 출력하세요.
item_comments, summary, next_step
item_comments의 각 항목은 item_no와 comment 두 칸만 가져야 합니다.
"""


@dataclass(frozen=True)
class GeneratedFeedback:
    item_comments: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""
    next_step: str = ""
    degraded: bool = False


def _terms(context: FeedbackContext, pii_terms: set[str] | None) -> set[str]:
    return {context.student_name, *(pii_terms or set())}


def _clean_text(
    value: str,
    *,
    context: FeedbackContext,
    pii_terms: set[str],
) -> str:
    masked, _ = mask_personal_names(value, pii_terms)
    return masked.replace(context.anonymous_token, "학생").strip()


def _build_user_text(context: FeedbackContext, pii_terms: set[str]) -> str:
    raw = (
        f"{context.grade}학년 {context.subject} 평가 결과입니다.\n"
        "이 학생에게 줄 피드백을 작성하세요.\n\n"
        + json.dumps(context.to_llm_payload(), ensure_ascii=False, indent=2)
    )
    masked, _ = mask_personal_names(raw, pii_terms)
    return masked


def _fallback(
    context: FeedbackContext,
    pii_terms: set[str],
) -> GeneratedFeedback:
    comments = [
        {
            "item_no": item.item_no,
            "score": item.score,
            "max": item.max_points,
            "comment": _clean_text(
                item.criterion,
                context=context,
                pii_terms=pii_terms,
            ),
        }
        for item in context.items
    ]
    weak = context.weak_items()
    if weak:
        titles = ", ".join(item.title for item in weak)
        next_step = f"다음 내용을 더 연습해 보세요: {titles}"
    else:
        next_step = "배운 내용을 다른 문제에도 적용해 보세요."
    summary = (
        f"총 {context.total_points}점 중 {context.total_score}점을 받았어요. "
        f"성취수준은 {context.level}수준입니다."
    )
    return GeneratedFeedback(
        item_comments=comments,
        summary=_clean_text(summary, context=context, pii_terms=pii_terms),
        next_step=_clean_text(next_step, context=context, pii_terms=pii_terms),
        degraded=True,
    )


def _parse_feedback(
    context: FeedbackContext,
    raw: str,
    pii_terms: set[str],
) -> GeneratedFeedback | None:
    if not isinstance(raw, str) or len(raw) > MAX_RAW_RESPONSE_LENGTH:
        return None
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if type(payload) is not dict or set(payload) != REQUIRED_KEYS:
        return None
    entries = payload["item_comments"]
    summary_value = payload["summary"]
    next_value = payload["next_step"]
    if (
        type(entries) is not list
        or not isinstance(summary_value, str)
        or not isinstance(next_value, str)
    ):
        return None

    allowed_items = {item.item_no for item in context.items}
    comments_by_item: dict[int, str] = {}
    for entry in entries:
        if type(entry) is not dict or set(entry) != COMMENT_KEYS:
            return None
        item_no = entry["item_no"]
        comment_value = entry["comment"]
        if (
            type(item_no) is not int
            or item_no not in allowed_items
            or item_no in comments_by_item
            or not isinstance(comment_value, str)
        ):
            return None
        comment = _clean_text(
            comment_value,
            context=context,
            pii_terms=pii_terms,
        )
        if not 1 <= len(comment) <= MAX_COMMENT_LENGTH:
            return None
        comments_by_item[item_no] = comment

    summary = _clean_text(
        summary_value,
        context=context,
        pii_terms=pii_terms,
    )
    next_step = _clean_text(
        next_value,
        context=context,
        pii_terms=pii_terms,
    )
    if (
        not 1 <= len(summary) <= MAX_SECTION_LENGTH
        or not 1 <= len(next_step) <= MAX_SECTION_LENGTH
    ):
        return None

    degraded = len(comments_by_item) != len(context.items)
    comments = [
        {
            "item_no": item.item_no,
            "score": item.score,
            "max": item.max_points,
            "comment": comments_by_item.get(item.item_no)
            or _clean_text(
                item.criterion,
                context=context,
                pii_terms=pii_terms,
            ),
        }
        for item in context.items
    ]
    return GeneratedFeedback(
        item_comments=comments,
        summary=summary,
        next_step=next_step,
        degraded=degraded,
    )


def generate_feedback(
    context: FeedbackContext,
    provider: LLMProvider,
    pii_terms: set[str] | None = None,
) -> GeneratedFeedback:
    safe_terms = _terms(context, pii_terms)
    try:
        response = LLMProvider.complete(
            provider,
            LLMRequest(
                system=SYSTEM_PROMPT,
                user_text=_build_user_text(context, safe_terms),
                max_output_tokens=6_000,
                json_output=True,
                purpose="generate_feedback",
                anonymous_token=context.anonymous_token,
            ),
        )
    except Exception:
        return _fallback(context, safe_terms)

    parsed = _parse_feedback(context, response.text, safe_terms)
    return parsed if parsed is not None else _fallback(context, safe_terms)
