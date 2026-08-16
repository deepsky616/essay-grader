from app.services.sanitize import mask_personal_names


def test_masks_roster_name():
    text, found = mask_personal_names(
        "김미래는 25%라고 답했다",
        {"김미래", "박균형"},
    )
    assert text == "[학생]는 25%라고 답했다"
    assert found == {"김미래"}


def test_masks_multiple_occurrences():
    text, _ = mask_personal_names("김미래와 김미래", {"김미래"})
    assert text == "[학생]와 [학생]"


def test_masks_multiple_names():
    text, found = mask_personal_names(
        "김미래와 박균형",
        {"김미래", "박균형"},
    )
    assert "김미래" not in text
    assert "박균형" not in text
    assert found == {"김미래", "박균형"}


def test_leaves_unrelated_text_untouched():
    original = "형광펜의 할인율은 25%이다"
    text, found = mask_personal_names(original, {"김미래"})
    assert text == original
    assert found == set()


def test_empty_term_set_is_noop():
    assert mask_personal_names("아무 말", set()) == ("아무 말", set())


def test_longer_names_are_masked_first():
    text, found = mask_personal_names(
        "김미래솔과 김미래",
        {"김미래", "김미래솔"},
    )
    assert text == "[학생]과 [학생]"
    assert found == {"김미래", "김미래솔"}


def test_blank_and_single_character_terms_are_ignored():
    original = "이는 답이다"
    assert mask_personal_names(original, {"", " ", "이"}) == (original, set())


def test_regex_characters_in_name_are_literal():
    text, found = mask_personal_names("A.B의 답", {"A.B"})
    assert text == "[학생]의 답"
    assert found == {"A.B"}
