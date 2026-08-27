import math

from app.services.grader import ItemGrade
from app.services.routing import RoutingInput, decide_route


def _grade(route="auto", score=2, confidence=0.95) -> ItemGrade:
    return ItemGrade(
        item_no=1,
        score=score,
        matched_criterion="정확",
        evidence="선대칭",
        reason="정답 2/2",
        confidence=confidence,
        route=route,
    )


def _input(**overrides) -> RoutingInput:
    defaults = dict(
        grade=_grade(),
        registration_quality=0.97,
        assignment_status="confirmed",
        confidence_threshold=0.90,
    )
    defaults.update(overrides)
    return RoutingInput(**defaults)


def test_clean_auto_item_is_confirmed():
    decision = decide_route(_input())
    assert decision.route == "auto"
    assert decision.reasons == []


def test_manual_grade_stays_manual_with_reason():
    decision = decide_route(_input(grade=_grade(route="manual", score=None)))
    assert decision.route == "manual"
    assert any("채점기" in reason for reason in decision.reasons)


def test_low_confidence_forces_manual():
    decision = decide_route(_input(grade=_grade(confidence=0.72)))
    assert decision.route == "manual"
    assert any("신뢰도" in reason for reason in decision.reasons)


def test_poor_registration_forces_manual():
    decision = decide_route(_input(registration_quality=0.55))
    assert decision.route == "manual"
    assert any("정합" in reason for reason in decision.reasons)


def test_unconfirmed_assignment_forces_manual():
    decision = decide_route(_input(assignment_status="needs_review"))
    assert decision.route == "manual"
    assert any("배정" in reason for reason in decision.reasons)


def test_multiple_problems_are_all_reported():
    decision = decide_route(
        _input(
            grade=_grade(confidence=0.4),
            registration_quality=0.3,
            assignment_status="needs_review",
        )
    )
    assert len(decision.reasons) == 3


def test_review_all_mode_forces_manual():
    decision = decide_route(_input(review_all=True))
    assert decision.route == "manual"
    assert any("전체 검토" in reason for reason in decision.reasons)


def test_threshold_is_configurable():
    decision = decide_route(
        _input(
            grade=_grade(confidence=0.80),
            confidence_threshold=0.75,
        )
    )
    assert decision.route == "auto"


def test_non_finite_quality_values_fail_closed():
    for value in (math.nan, math.inf, -math.inf):
        decision = decide_route(_input(registration_quality=value))
        assert decision.route == "manual"
        assert any("정합" in reason for reason in decision.reasons)


def test_invalid_confidence_threshold_fails_closed():
    for value in (-0.1, 1.1, math.nan):
        decision = decide_route(_input(confidence_threshold=value))
        assert decision.route == "manual"
        assert any("기준" in reason for reason in decision.reasons)


def test_invalid_grade_confidence_fails_closed():
    decision = decide_route(_input(grade=_grade(confidence=math.nan)))
    assert decision.route == "manual"
    assert any("신뢰도" in reason for reason in decision.reasons)
