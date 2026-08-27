import pytest

from app.services.levels import LevelError, determine_level, suggest_cutoffs


CUTOFFS = {"3": 17, "2": 11, "1": 0}


@pytest.mark.parametrize("total", [20, 17])
def test_top_level(total):
    assert determine_level(total, CUTOFFS) == "3"


@pytest.mark.parametrize("total", [16, 11])
def test_middle_level(total):
    assert determine_level(total, CUTOFFS) == "2"


@pytest.mark.parametrize("total", [10, 0])
def test_bottom_level(total):
    assert determine_level(total, CUTOFFS) == "1"


@pytest.mark.parametrize(
    "cutoffs",
    [
        {},
        {"3": 17, "2": 11},
        {"3": 17, "2": 11, "1": 0, "4": 20},
        {"3": 17, "2": 11, "1": "0"},
        {"3": 11, "2": 11, "1": 0},
        {"3": 17, "2": 0, "1": 1},
    ],
)
def test_invalid_cutoffs_raise(cutoffs):
    with pytest.raises(LevelError, match="컷오프"):
        determine_level(10, cutoffs)


@pytest.mark.parametrize("total", [-1, 1.5, True])
def test_invalid_total_raises(total):
    with pytest.raises(LevelError, match="총점"):
        determine_level(total, CUTOFFS)


def test_suggest_cutoffs_uses_documented_ratios():
    assert suggest_cutoffs(total_points=20) == {"3": 17, "2": 9, "1": 0}


def test_suggest_cutoffs_for_small_total():
    assert suggest_cutoffs(total_points=4) == {"3": 4, "2": 2, "1": 0}


@pytest.mark.parametrize("total_points", [1, 0, -1, 2.5, True])
def test_suggest_cutoffs_rejects_impossible_or_invalid_total(total_points):
    with pytest.raises(LevelError, match="총점"):
        suggest_cutoffs(total_points)
