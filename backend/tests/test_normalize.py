from app.services.normalize import normalize_value, snap_to_candidates


def test_removes_numeric_units():
    assert normalize_value("10,000원") == "10000"
    assert normalize_value("25%") == "25"
    assert normalize_value("25 퍼센트") == "25"
    assert normalize_value("2점") == "2"


def test_does_not_remove_unit_words_from_regular_answers():
    assert normalize_value("점대칭") == "점대칭"
    assert normalize_value("개념") == "개념"


def test_removes_thousands_separator_comma():
    assert normalize_value("10,000") == "10000"
    assert normalize_value("1,234,567") == "1234567"


def test_period_as_thousands_separator():
    assert normalize_value("10.000") == "10000"
    assert normalize_value("1.234.567") == "1234567"


def test_period_as_decimal_point_is_preserved():
    assert normalize_value("0.1") == "0.1"
    assert normalize_value("3.14") == "3.14"


def test_whitespace_is_collapsed():
    assert normalize_value("  선 대칭  ") == "선대칭"


def test_fullwidth_digits_are_folded():
    assert normalize_value("２５") == "25"


def test_snap_returns_exact_match():
    result = snap_to_candidates("10000", ["10,000", "6,000", "4,000"])
    assert result.matched == "10,000"
    assert result.distance == 0


def test_snap_recovers_single_character_error():
    result = snap_to_candidates("l0,000", ["10,000", "6,000", "4,000"])
    assert result.matched == "10,000"


def test_snap_rejects_distant_input():
    result = snap_to_candidates("전혀다른것", ["10,000", "6,000"])
    assert result.matched is None


def test_snap_does_not_guess_when_tied():
    result = snap_to_candidates("X000", ["1000", "2000"])
    assert result.matched is None
    assert result.ambiguous


def test_snap_uses_aliases():
    result = snap_to_candidates(
        "선 대칭 도형",
        ["선대칭"],
        aliases={"선대칭": ["선대칭도형"]},
    )
    assert result.matched == "선대칭"


def test_alias_and_primary_form_for_same_candidate_are_not_ambiguous():
    result = snap_to_candidates(
        "선대칭",
        ["선대칭"],
        aliases={"선대칭": ["선 대칭"]},
    )
    assert result.matched == "선대칭"
    assert not result.ambiguous


def test_snap_with_empty_input_or_candidates():
    assert snap_to_candidates("", ["10,000"]).matched is None
    assert snap_to_candidates("10,000", []).matched is None


def test_snap_uses_true_edit_distance_for_transposition():
    result = snap_to_candidates("12354", ["12345", "99999"])
    assert result.distance == 2
