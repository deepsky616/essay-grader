"""스캔 배치를 학생별, 문항별 비식별 크롭까지 순수하게 처리한다."""

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from app.providers.local_ocr import LocalOCRProvider, LocalOCRUnavailable
from app.services.batch_split import SplitFailed, split_by_page_sequence
from app.services.cropper import CropSpec, Rect, crop_region
from app.services.ink_extract import extract_ink
from app.services.markers import (
    MAX_PAGES,
    MarkerDetectionError,
    detect_page_markers,
)
from app.services.registration import RegistrationFailed, Registered, register_page
from app.services.roster_match import MatchOutcome, match_name


ProgressFn = Callable[[int, int, str], None]
MAX_IMAGE_VALUES = 100_000_000
MAX_PIPELINE_REGIONS = 500


class PipelineOutcome(str, Enum):
    OK = "ok"
    NEEDS_REVIEW = "needs_review"
    SPLIT_FAILED = "split_failed"


@dataclass
class StudentResult:
    index: int
    page_range: tuple[int, int]
    crops: dict[int, np.ndarray] = field(default_factory=dict)
    ink_crops: dict[int, np.ndarray] = field(default_factory=dict)
    aligned_pages: dict[int, np.ndarray] = field(default_factory=dict)
    ink_pages: dict[int, np.ndarray] = field(default_factory=dict)
    registration_quality: dict[int, float] = field(default_factory=dict)
    recognized_name: str | None = None
    assignment_status: str = "pending"
    assignment_note: str | None = None


@dataclass
class PipelineResult:
    outcome: PipelineOutcome
    students: list[StudentResult] = field(default_factory=list)
    failure_reason: str | None = None


def _image_is_valid(image: object) -> bool:
    return (
        isinstance(image, np.ndarray)
        and image.dtype == np.uint8
        and image.size > 0
        and image.size <= MAX_IMAGE_VALUES
        and (
            image.ndim == 2
            or (image.ndim == 3 and image.shape[2] in (3, 4))
        )
    )


def _template_mode(templates: dict[int, np.ndarray]) -> str:
    modes: list[str] = []
    for page_no, template in templates.items():
        try:
            detected = detect_page_markers(template)
        except (MarkerDetectionError, ValueError) as exc:
            raise ValueError("파이프라인 템플릿 마커가 올바르지 않습니다.") from exc
        if detected is None:
            modes.append("features")
        elif detected.page_no != page_no or not detected.is_complete:
            raise ValueError("파이프라인 템플릿의 쪽 마커가 올바르지 않습니다.")
        else:
            modes.append("markers")
    if len(set(modes)) != 1:
        raise ValueError("파이프라인 템플릿의 마커 방식이 서로 다릅니다.")
    return modes[0]


def _checked_contract(
    scan_pages: list[np.ndarray],
    templates: dict[int, np.ndarray],
    pages_per_student: int,
    crop_specs: dict[int, list[CropSpec]],
    pii_rect: tuple[int, Rect],
    roster: list[str],
    local_ocr: LocalOCRProvider,
    expected_students: int | None,
    progress: ProgressFn | None,
) -> tuple[str, int, Rect, int]:
    if type(scan_pages) is not list or not scan_pages or not all(
        _image_is_valid(page) for page in scan_pages
    ):
        raise ValueError("파이프라인 스캔 페이지 목록이 올바르지 않습니다.")
    if (
        type(pages_per_student) is not int
        or not 1 <= pages_per_student <= MAX_PAGES
    ):
        raise ValueError("파이프라인 학생당 쪽 수가 올바르지 않습니다.")
    if (
        type(templates) is not dict
        or set(templates) != set(range(1, pages_per_student + 1))
        or not all(_image_is_valid(template) for template in templates.values())
    ):
        raise ValueError("파이프라인 템플릿 목록이 올바르지 않습니다.")
    if (
        type(crop_specs) is not dict
        or not crop_specs
        or sum(len(specs) for specs in crop_specs.values() if isinstance(specs, list))
        > MAX_PIPELINE_REGIONS
    ):
        raise ValueError("파이프라인 응답 영역 목록이 비어 있거나 올바르지 않습니다.")

    item_numbers: list[int] = []
    for page_no, specs in crop_specs.items():
        if (
            type(page_no) is not int
            or page_no not in templates
            or type(specs) is not list
            or not specs
            or any(type(spec) is not CropSpec for spec in specs)
        ):
            raise ValueError("파이프라인 응답 영역 정보가 올바르지 않습니다.")
        item_numbers.extend(spec.item_no for spec in specs)
    if len(set(item_numbers)) != len(item_numbers):
        raise ValueError("파이프라인 응답 영역의 문항 번호가 중복되었습니다.")

    if (
        type(pii_rect) is not tuple
        or len(pii_rect) != 2
        or type(pii_rect[0]) is not int
        or pii_rect[0] not in templates
        or type(pii_rect[1]) is not tuple
        or len(pii_rect[1]) != 4
        or any(type(value) is not int for value in pii_rect[1])
    ):
        raise ValueError("파이프라인 식별정보 영역이 올바르지 않습니다.")
    pii_page_no, pii_box = pii_rect
    pii_x, pii_y, pii_width, pii_height = pii_box
    template_height, template_width = templates[pii_page_no].shape[:2]
    if (
        pii_x < 0
        or pii_y < 0
        or pii_width <= 0
        or pii_height <= 0
        or pii_x + pii_width > template_width
        or pii_y + pii_height > template_height
    ):
        raise ValueError("파이프라인 식별정보 영역이 페이지를 벗어났습니다.")

    for page_no, specs in crop_specs.items():
        for spec in specs:
            crop_region(
                templates[page_no],
                spec,
                pii_rects=[pii_box] if page_no == pii_page_no else None,
            )

    if type(roster) is not list or not roster:
        raise ValueError("파이프라인 명렬표가 비어 있거나 올바르지 않습니다.")
    try:
        match_name("", roster)
    except ValueError as exc:
        raise ValueError("파이프라인 명렬표가 올바르지 않습니다.") from exc
    if not callable(getattr(local_ocr, "recognize", None)):
        raise ValueError("파이프라인 로컬 인식 손잡이가 올바르지 않습니다.")
    if progress is not None and not callable(progress):
        raise ValueError("파이프라인 진행률 손잡이가 올바르지 않습니다.")

    if expected_students is None:
        effective_expected = len(roster)
    elif (
        type(expected_students) is not int
        or expected_students < 1
        or expected_students != len(roster)
    ):
        raise ValueError("파이프라인 예상 학생 수가 명렬표와 다릅니다.")
    else:
        effective_expected = expected_students

    return (
        _template_mode(templates),
        pii_page_no,
        pii_box,
        effective_expected,
    )


def _register_marked_page(
    scan: np.ndarray,
    templates: dict[int, np.ndarray],
) -> tuple[Registered | None, str | None]:
    try:
        detected = detect_page_markers(scan)
    except (MarkerDetectionError, ValueError):
        return None, "안전하게 해석할 수 없는 마커 조합이 검출되었습니다."
    if detected is None:
        return None, "쪽 번호 마커를 찾지 못했습니다."
    if detected.page_no not in templates:
        return None, "답안지 템플릿에 없는 쪽 번호 마커가 검출되었습니다."
    try:
        return register_page(scan, templates[detected.page_no]), None
    except RegistrationFailed as exc:
        return None, str(exc)


def _register_feature_page(
    scan: np.ndarray,
    templates: dict[int, np.ndarray],
) -> tuple[Registered | None, str | None]:
    candidates: list[tuple[int, Registered]] = []
    for page_no, template in templates.items():
        try:
            candidates.append((page_no, register_page(scan, template)))
        except RegistrationFailed:
            continue
    if not candidates:
        return None, "특징점으로 맞는 템플릿 쪽을 찾지 못했습니다."
    candidates.sort(key=lambda item: item[1].quality, reverse=True)
    if (
        len(candidates) > 1
        and candidates[0][1].quality - candidates[1][1].quality < 0.05
    ):
        return None, "특징점 정합 결과가 여러 템플릿 사이에서 애매합니다."
    page_no, best = candidates[0]
    return (
        Registered(
            page_no=page_no,
            aligned=best.aligned,
            quality=best.quality,
            method="features",
        ),
        None,
    )


def _register_all(
    scan_pages: list[np.ndarray],
    templates: dict[int, np.ndarray],
    template_mode: str,
    progress: ProgressFn | None,
) -> tuple[list[Registered | None], list[str | None]]:
    registered: list[Registered | None] = []
    reasons: list[str | None] = []
    total = len(scan_pages)
    for index, scan in enumerate(scan_pages):
        if template_mode == "markers":
            result, reason = _register_marked_page(scan, templates)
        else:
            result, reason = _register_feature_page(scan, templates)
        registered.append(result)
        reasons.append(reason)
        if progress is not None:
            progress(index + 1, total, f"{index + 1}/{total}쪽 정합")
    return registered, reasons


def _split_or_failure(
    registered: list[Registered | None],
    reasons: list[str | None],
    pages_per_student: int,
    expected_students: int,
) -> tuple[tuple[tuple[int, int], ...] | None, PipelineResult | None]:
    page_numbers = [item.page_no if item is not None else None for item in registered]
    try:
        split = split_by_page_sequence(
            page_numbers,
            pages_per_student,
            expected_students=expected_students,
        )
    except SplitFailed as exc:
        message = str(exc)
        for index, item in enumerate(registered):
            if item is None and reasons[index]:
                message = (
                    f"{message} {index + 1}번째 페이지 상세: {reasons[index]}"
                )
                break
        return None, PipelineResult(PipelineOutcome.SPLIT_FAILED, [], message)
    return split.page_ranges, None


def _verify_name(
    student: StudentResult,
    name_crop: np.ndarray,
    expected_name: str,
    roster: list[str],
    local_ocr: LocalOCRProvider,
) -> bool:
    try:
        raw = local_ocr.recognize(name_crop)
    except LocalOCRUnavailable:
        student.assignment_status = "needs_review"
        student.assignment_note = "로컬 이름 인식기를 사용할 수 없어 배정 확인이 필요합니다."
        return True

    try:
        match = match_name(raw, roster)
    except ValueError:
        student.assignment_status = "needs_review"
        student.assignment_note = "이름 인식 결과 형식이 올바르지 않아 배정 확인이 필요합니다."
        return True

    student.recognized_name = raw or None
    if match.outcome is MatchOutcome.MATCHED and match.name == expected_name:
        student.assignment_status = "confirmed"
        return False
    student.assignment_status = "needs_review"
    if match.outcome is MatchOutcome.MATCHED:
        student.assignment_note = (
            "쪽 번호 순서의 학생과 이름란의 명렬표 후보가 다릅니다."
        )
    else:
        student.assignment_note = "이름란을 명렬표와 유일하게 대조하지 못했습니다."
    return True


def process_batch_pages(
    scan_pages: list[np.ndarray],
    templates: dict[int, np.ndarray],
    pages_per_student: int,
    crop_specs: dict[int, list[CropSpec]],
    pii_rect: tuple[int, Rect],
    roster: list[str],
    local_ocr: LocalOCRProvider,
    expected_students: int | None = None,
    progress: ProgressFn | None = None,
) -> PipelineResult:
    """전체 안전 검증을 통과한 배치만 학생별 비식별 크롭으로 만든다."""
    template_mode, pii_page_no, pii_box, effective_expected = _checked_contract(
        scan_pages,
        templates,
        pages_per_student,
        crop_specs,
        pii_rect,
        roster,
        local_ocr,
        expected_students,
        progress,
    )
    registered, reasons = _register_all(
        scan_pages,
        templates,
        template_mode,
        progress,
    )
    page_ranges, failure = _split_or_failure(
        registered,
        reasons,
        pages_per_student,
        effective_expected,
    )
    if failure is not None:
        return failure
    assert page_ranges is not None

    students: list[StudentResult] = []
    needs_review = False
    for student_index, (start, end) in enumerate(page_ranges):
        student = StudentResult(index=student_index, page_range=(start, end))
        for offset in range(start, end):
            registered_page = registered[offset]
            assert registered_page is not None
            assert registered_page.page_no is not None
            page_no = registered_page.page_no
            template = templates[page_no]
            ink = extract_ink(registered_page.aligned, template)

            student.aligned_pages[page_no] = registered_page.aligned
            student.ink_pages[page_no] = ink
            student.registration_quality[page_no] = registered_page.quality
            for spec in crop_specs.get(page_no, []):
                pii = [pii_box] if page_no == pii_page_no else None
                student.crops[spec.item_no] = crop_region(
                    registered_page.aligned,
                    spec,
                    pii_rects=pii,
                )
                student.ink_crops[spec.item_no] = crop_region(
                    ink,
                    spec,
                    pii_rects=pii,
                )

            if page_no == pii_page_no:
                pii_x, pii_y, pii_width, pii_height = pii_box
                name_crop = crop_region(
                    registered_page.aligned,
                    CropSpec(
                        item_no=1,
                        x=pii_x,
                        y=pii_y,
                        width=pii_width,
                        height=pii_height,
                    ),
                )
                needs_review = (
                    _verify_name(
                        student,
                        name_crop,
                        roster[student_index],
                        roster,
                        local_ocr,
                    )
                    or needs_review
                )
        students.append(student)

    outcome = PipelineOutcome.NEEDS_REVIEW if needs_review else PipelineOutcome.OK
    return PipelineResult(outcome, students, None)
