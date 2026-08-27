import pytest

from app.services.batch_split import SplitFailed, split_by_page_sequence


def test_clean_batch_splits_into_students() -> None:
    result = split_by_page_sequence(
        [1, 2, 3, 1, 2, 3, 1, 2, 3],
        pages_per_student=3,
    )

    assert result.student_count == 3
    assert result.page_ranges == ((0, 3), (3, 6), (6, 9))


def test_single_page_answer_sheet() -> None:
    result = split_by_page_sequence([1, 1, 1, 1], pages_per_student=1)

    assert result.student_count == 4
    assert result.page_ranges == ((0, 1), (1, 2), (2, 3), (3, 4))


def test_missing_page_is_detected_with_position() -> None:
    with pytest.raises(SplitFailed) as caught:
        split_by_page_sequence(
            [1, 2, 3, 1, 2, 3, 1, 3, 1, 2, 3],
            pages_per_student=3,
        )

    assert "8번째" in str(caught.value)
    assert "3번" in str(caught.value)


def test_duplicate_page_is_detected() -> None:
    with pytest.raises(SplitFailed) as caught:
        split_by_page_sequence([1, 2, 2, 3, 1, 2, 3], pages_per_student=3)

    assert "3번째" in str(caught.value)


def test_total_page_count_mismatch_is_detected() -> None:
    with pytest.raises(SplitFailed, match="총 쪽수"):
        split_by_page_sequence([1, 2, 3, 1, 2], pages_per_student=3)


def test_unreadable_page_is_reported() -> None:
    with pytest.raises(SplitFailed) as caught:
        split_by_page_sequence([1, 2, 3, 1, None, 3], pages_per_student=3)

    assert "5번째" in str(caught.value)
    assert "마커" in str(caught.value)


def test_empty_batch_is_rejected() -> None:
    with pytest.raises(SplitFailed, match="비어"):
        split_by_page_sequence([], pages_per_student=3)


def test_expected_student_count_is_enforced() -> None:
    with pytest.raises(SplitFailed, match="명렬표"):
        split_by_page_sequence(
            [1, 2, 3, 1, 2, 3],
            pages_per_student=3,
            expected_students=5,
        )


def test_expected_student_count_matching_passes() -> None:
    result = split_by_page_sequence(
        [1, 2, 3, 1, 2, 3],
        pages_per_student=3,
        expected_students=2,
    )

    assert result.student_count == 2


@pytest.mark.parametrize("pages_per_student", [True, 0, -1, 63, 2.0])
def test_rejects_invalid_pages_per_student(pages_per_student: object) -> None:
    with pytest.raises(SplitFailed, match="학생 1인당"):
        split_by_page_sequence([1], pages_per_student=pages_per_student)  # type: ignore[arg-type]


@pytest.mark.parametrize("expected_students", [True, 0, -1, 2.0])
def test_rejects_invalid_expected_students(expected_students: object) -> None:
    with pytest.raises(SplitFailed, match="명렬표"):
        split_by_page_sequence(
            [1],
            pages_per_student=1,
            expected_students=expected_students,  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("page_number", [True, 1.0, "1", 0, -1, 4])
def test_rejects_invalid_read_page_number(page_number: object) -> None:
    with pytest.raises(SplitFailed, match="쪽 번호"):
        split_by_page_sequence(
            [page_number, 2, 3],  # type: ignore[list-item]
            pages_per_student=3,
        )


def test_rejects_non_list_sequence() -> None:
    with pytest.raises(SplitFailed, match="수열"):
        split_by_page_sequence((1, 2, 3), pages_per_student=3)  # type: ignore[arg-type]


def test_input_sequence_is_not_modified() -> None:
    pages = [1, 2, 1, 2]
    original = pages.copy()

    split_by_page_sequence(pages, pages_per_student=2)

    assert pages == original
