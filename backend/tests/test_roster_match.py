import pytest

from app.services.roster_match import MatchOutcome, match_name


ROSTER = ["김미래", "박균형", "이자율", "최대칭", "정비율"]


def test_exact_match() -> None:
    result = match_name("김미래", ROSTER)

    assert result.outcome == MatchOutcome.MATCHED
    assert result.name == "김미래"


def test_whitespace_is_ignored() -> None:
    assert match_name(" 박 균형\n", ROSTER).name == "박균형"


def test_single_character_error_is_recovered() -> None:
    result = match_name("김미돼", ROSTER)

    assert result.outcome == MatchOutcome.MATCHED
    assert result.name == "김미래"


def test_single_character_insertion_or_deletion_is_recovered() -> None:
    assert match_name("김미래래", ROSTER).name == "김미래"
    assert match_name("김미", ROSTER).name == "김미래"


def test_ambiguous_input_is_not_guessed() -> None:
    result = match_name("김미", ["김미래", "김미소"])

    assert result.outcome == MatchOutcome.AMBIGUOUS
    assert result.name is None


def test_duplicate_normalized_names_are_ambiguous() -> None:
    result = match_name("김미래", ["김미래", "김 미래"])

    assert result.outcome == MatchOutcome.AMBIGUOUS
    assert result.name is None


def test_far_input_is_unmatched() -> None:
    result = match_name("완전히다른글자", ROSTER)

    assert result.outcome == MatchOutcome.UNMATCHED
    assert result.name is None


def test_empty_input_is_unmatched() -> None:
    assert match_name("  \n", ROSTER).outcome == MatchOutcome.UNMATCHED


def test_empty_roster_is_unmatched() -> None:
    assert match_name("김미래", []).outcome == MatchOutcome.UNMATCHED


def test_match_reports_real_edit_distance() -> None:
    assert match_name("김미래", ROSTER).distance == 0
    assert match_name("김미돼", ROSTER).distance == 1
    assert match_name("미김래", ROSTER).distance == 2


def test_decomposed_unicode_is_normalized() -> None:
    decomposed = "김미래"

    assert match_name(decomposed, ROSTER).name == "김미래"


@pytest.mark.parametrize(
    ("raw", "roster"),
    [
        (None, ROSTER),
        ("김미래", ("김미래",)),
        ("김미래", [1]),
        ("김미래", [""]),
    ],
)
def test_rejects_invalid_input(raw: object, roster: object) -> None:
    with pytest.raises(ValueError, match="이름"):
        match_name(raw, roster)  # type: ignore[arg-type]


def test_rejects_oversized_input() -> None:
    with pytest.raises(ValueError, match="이름"):
        match_name("가" * 201, ROSTER)

    with pytest.raises(ValueError, match="명렬표"):
        match_name("김미래", [f"학생{index}" for index in range(501)])


def test_roster_is_not_modified() -> None:
    roster = ROSTER.copy()
    original = roster.copy()

    match_name("김미돼", roster)

    assert roster == original
