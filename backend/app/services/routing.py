"""설계 문서 7.6절의 자동 확정과 교사 검토 최종 판정."""

import math
from dataclasses import dataclass, field

from app.services.grader import ItemGrade


DEFAULT_CONFIDENCE_THRESHOLD = 0.90
MIN_REGISTRATION_QUALITY = 0.80


@dataclass(frozen=True)
class RoutingInput:
    grade: ItemGrade
    registration_quality: float
    assignment_status: str
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD
    review_all: bool = False


@dataclass
class RoutingDecision:
    route: str
    reasons: list[str] = field(default_factory=list)


def _unit_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
        and 0.0 <= float(value) <= 1.0
    )


def decide_route(payload: RoutingInput) -> RoutingDecision:
    reasons: list[str] = []

    if payload.review_all:
        reasons.append("전체 검토 모드가 켜져 있습니다.")

    if payload.grade.route != "auto":
        reasons.append("채점기가 교사 검토로 지정했습니다.")

    if payload.grade.score is None:
        reasons.append("채점 결과가 없습니다.")

    if not _unit_number(payload.confidence_threshold):
        reasons.append("자동 확정 신뢰도 기준이 올바르지 않습니다.")
    elif not _unit_number(payload.grade.confidence):
        reasons.append("인식 신뢰도가 올바르지 않습니다.")
    elif payload.grade.confidence < payload.confidence_threshold:
        reasons.append(
            "인식 신뢰도가 자동 확정 기준보다 낮습니다 "
            f"({payload.grade.confidence:.2f} < "
            f"{payload.confidence_threshold:.2f})."
        )

    if not _unit_number(payload.registration_quality):
        reasons.append("페이지 정합 품질이 올바르지 않습니다.")
    elif payload.registration_quality < MIN_REGISTRATION_QUALITY:
        reasons.append(
            "페이지 정합 품질이 낮습니다 "
            f"({payload.registration_quality:.2f} < "
            f"{MIN_REGISTRATION_QUALITY:.2f})."
        )

    if payload.assignment_status != "confirmed":
        reasons.append("학생 배정이 확정되지 않았습니다.")

    return RoutingDecision(
        route="manual" if reasons else "auto",
        reasons=reasons,
    )
