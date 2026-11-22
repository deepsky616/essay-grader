import pytest

from app.services.conditions import ConditionContext, SetMatch, evaluate_condition


def _ctx(
    correct: int,
    total: int,
    set_match: SetMatch = SetMatch.NONE,
) -> ConditionContext:
    return ConditionContext(
        correct_count=correct,
        total_count=total,
        set_match=set_match,
    )


def test_all_correct():
    assert evaluate_condition("all_correct", _ctx(2, 2))
    assert not evaluate_condition("all_correct", _ctx(1, 2))


def test_all_correct_is_false_when_nothing_to_check():
    assert not evaluate_condition("all_correct", _ctx(0, 0))


def test_none_correct():
    assert evaluate_condition("none_correct", _ctx(0, 2))
    assert not evaluate_condition("none_correct", _ctx(1, 2))
    assert not evaluate_condition("none_correct", _ctx(0, 0))


def test_partial_exact_count():
    assert evaluate_condition("partial:1", _ctx(1, 2))
    assert not evaluate_condition("partial:1", _ctx(2, 2))


def test_partial_at_least():
    assert evaluate_condition("partial:>=2", _ctx(3, 4))
    assert evaluate_condition("partial:>=2", _ctx(2, 4))
    assert not evaluate_condition("partial:>=2", _ctx(1, 4))


def test_set_exact():
    assert evaluate_condition("set_exact", _ctx(0, 0, SetMatch.EXACT))
    assert not evaluate_condition("set_exact", _ctx(0, 0, SetMatch.PARTIAL))


def test_set_partial():
    assert evaluate_condition("set_partial", _ctx(0, 0, SetMatch.PARTIAL))
    assert not evaluate_condition("set_partial", _ctx(0, 0, SetMatch.EXACT))


def test_llm_and_manual_cannot_be_auto_evaluated():
    for condition in ("llm", "manual"):
        with pytest.raises(ValueError, match="자동 평가"):
            evaluate_condition(condition, _ctx(1, 1))


def test_unknown_condition_raises():
    with pytest.raises(ValueError, match="알 수 없는"):
        evaluate_condition("mostly_right", _ctx(1, 1))


@pytest.mark.parametrize(("correct", "total"), [(-1, 1), (0, -1), (2, 1)])
def test_context_rejects_impossible_counts(correct, total):
    with pytest.raises(ValueError, match="개수"):
        _ctx(correct, total)


def test_partial_target_cannot_exceed_total():
    assert not evaluate_condition("partial:3", _ctx(2, 2))
    assert not evaluate_condition("partial:>=3", _ctx(2, 2))
