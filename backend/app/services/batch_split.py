"""쪽 번호 마커 수열을 검증해 스캔 배치를 학생별로 나눈다."""

from dataclasses import dataclass

from app.services.markers import MAX_PAGES


MAX_BATCH_PAGES = 100_000


class SplitFailed(Exception):
    """분할을 안전하게 수행할 수 없어 배치 전체를 멈춰야 할 때 발생한다."""


@dataclass(frozen=True)
class SplitResult:
    pages_per_student: int
    page_ranges: tuple[tuple[int, int], ...]

    @property
    def student_count(self) -> int:
        return len(self.page_ranges)


def _describe(index: int, pages_per_student: int) -> str:
    student_ordinal = index // pages_per_student + 1
    return f"{index + 1}번째 스캔 페이지({student_ordinal}번 학생 구간)"


def split_by_page_sequence(
    page_numbers: list[int | None],
    pages_per_student: int,
    expected_students: int | None = None,
) -> SplitResult:
    """모든 안전 조건을 통과한 경우에만 학생별 반열린 쪽 범위를 돌려준다."""
    if (
        type(pages_per_student) is not int
        or not 1 <= pages_per_student <= MAX_PAGES
    ):
        raise SplitFailed(
            f"학생 1인당 쪽수는 1부터 {MAX_PAGES}까지의 정수여야 합니다."
        )
    if (
        expected_students is not None
        and (type(expected_students) is not int or expected_students < 1)
    ):
        raise SplitFailed("명렬표의 예상 학생 수는 1 이상의 정수여야 합니다.")
    if type(page_numbers) is not list:
        raise SplitFailed("쪽 번호 수열은 목록이어야 합니다.")
    if not page_numbers:
        raise SplitFailed("스캔 배치가 비어 있습니다.")
    if len(page_numbers) > MAX_BATCH_PAGES:
        raise SplitFailed("스캔 배치의 총 쪽수가 처리 한도를 넘었습니다.")

    for index, page_no in enumerate(page_numbers):
        location = _describe(index, pages_per_student)
        if page_no is None:
            raise SplitFailed(
                f"{location}에서 쪽 번호 마커를 읽지 못했습니다. "
                "장이 뒤집혔거나 심하게 접혔을 수 있습니다."
            )
        if type(page_no) is not int or not 1 <= page_no <= pages_per_student:
            raise SplitFailed(
                f"{location}의 쪽 번호가 지원 범위를 벗어났습니다."
            )

        expected_page = index % pages_per_student + 1
        if page_no != expected_page:
            raise SplitFailed(
                f"{location}에서 쪽 번호가 어긋났습니다. "
                f"{expected_page}쪽이 와야 하는데 {page_no}쪽이 읽혔습니다. "
                "장이 누락되었거나 겹쳐 급지되었을 수 있습니다. "
                "이 지점부터 학생 배정이 밀리므로 배치를 중단합니다."
            )

    total = len(page_numbers)
    if total % pages_per_student != 0:
        raise SplitFailed(
            f"총 쪽수 {total}쪽이 학생 1인당 쪽수 {pages_per_student}쪽으로 "
            "나누어떨어지지 않습니다. 마지막 구간의 누락 여부를 확인하세요."
        )

    student_count = total // pages_per_student
    if expected_students is not None and student_count != expected_students:
        raise SplitFailed(
            f"스캔에서 학생 {student_count}명분이 나왔는데 명렬표 기준으로는 "
            f"{expected_students}명이어야 합니다. 결시자 처리를 확인하세요."
        )

    page_ranges = tuple(
        (index * pages_per_student, (index + 1) * pages_per_student)
        for index in range(student_count)
    )
    return SplitResult(
        pages_per_student=pages_per_student,
        page_ranges=page_ranges,
    )
