import cv2
import numpy as np
import pytest

from app.providers.local_ocr import LocalOCRUnavailable
from app.services.cropper import CropSpec, PIIBoundaryViolation
from app.services.markers import encode_marker_id, render_marker
from app.services.scan_pipeline import PipelineOutcome, process_batch_pages
from tests.fakes import FakeLocalOCR


def _template_page(
    page_no: int,
    width: int = 800,
    height: int = 1100,
    margin: int = 50,
    marker: int = 80,
) -> np.ndarray:
    page = np.full((height, width), 255, dtype=np.uint8)
    positions = [
        (margin, margin),
        (width - margin - marker, margin),
        (width - margin - marker, height - margin - marker),
        (margin, height - margin - marker),
    ]
    for corner, (x, y) in enumerate(positions):
        page[y : y + marker, x : x + marker] = render_marker(
            encode_marker_id(page_no, corner),
            size_px=marker,
        )
    cv2.rectangle(page, (150, 300), (650, 420), 0, 2)
    cv2.rectangle(page, (150, 150), (650, 220), 0, 2)
    cv2.putText(
        page,
        f"page-{page_no}",
        (280, 600),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.2,
        0,
        3,
    )
    return page


def _written(template: np.ndarray, text_mark: bool = True) -> np.ndarray:
    page = template.copy()
    cv2.line(page, (200, 360), (600, 370), 0, 5)
    if text_mark:
        cv2.line(page, (200, 190), (400, 192), 0, 4)
    return page


@pytest.fixture
def templates() -> dict[int, np.ndarray]:
    return {1: _template_page(1), 2: _template_page(2)}


@pytest.fixture
def crop_specs() -> dict[int, list[CropSpec]]:
    return {
        1: [CropSpec(item_no=1, x=150, y=300, width=500, height=120)],
        2: [CropSpec(item_no=2, x=150, y=300, width=500, height=120)],
    }


@pytest.fixture
def pii_spec() -> tuple[int, tuple[int, int, int, int]]:
    return (1, (150, 150, 500, 70))


def _clean_scans(templates: dict[int, np.ndarray]) -> list[np.ndarray]:
    return [
        _written(templates[1]),
        _written(templates[2]),
        _written(templates[1]),
        _written(templates[2]),
    ]


def test_clean_batch_produces_crops_for_each_student(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    result = process_batch_pages(
        scan_pages=_clean_scans(templates),
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "박균형"]),
    )

    assert result.outcome == PipelineOutcome.OK
    assert len(result.students) == 2
    assert [student.assignment_status for student in result.students] == [
        "confirmed",
        "confirmed",
    ]
    assert set(result.students[0].crops) == {1, 2}
    assert result.students[0].crops[1].shape == (120, 500)
    assert not result.students[0].crops[1].flags.writeable


def test_name_mismatch_marks_student_for_review(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    result = process_batch_pages(
        scan_pages=_clean_scans(templates),
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "완전히다른이름"]),
    )

    assert result.outcome == PipelineOutcome.NEEDS_REVIEW
    assert result.students[1].assignment_status == "needs_review"
    assert result.students[0].assignment_status == "confirmed"
    assert result.students[1].crops


def test_read_name_belonging_to_another_student_is_not_reassigned(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    result = process_batch_pages(
        scan_pages=_clean_scans(templates),
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["박균형", "박균형"]),
    )

    assert result.outcome == PipelineOutcome.NEEDS_REVIEW
    assert result.students[0].assignment_status == "needs_review"
    assert result.students[0].recognized_name == "박균형"


def test_local_ocr_unavailable_marks_student_for_review(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    class UnavailableOCR:
        def recognize(self, _image: np.ndarray) -> str:
            raise LocalOCRUnavailable("지역 실행 파일 없음")

    result = process_batch_pages(
        scan_pages=[_written(templates[1]), _written(templates[2])],
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래"],
        local_ocr=UnavailableOCR(),
    )

    assert result.outcome == PipelineOutcome.NEEDS_REVIEW
    assert result.students[0].assignment_status == "needs_review"
    assert result.students[0].recognized_name is None
    assert "로컬" in (result.students[0].assignment_note or "")


def test_misfeed_aborts_entire_batch_before_ocr(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    ocr = FakeLocalOCR(["김미래", "박균형"])
    scans = [
        _written(templates[1]),
        _written(templates[2]),
        _written(templates[1]),
        _written(templates[1]),
    ]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=ocr,
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED
    assert result.students == []
    assert "4번째" in (result.failure_reason or "")
    assert ocr.calls == []


def test_unregistrable_page_aborts_batch(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    scans = [
        _written(templates[1]),
        np.full((1100, 800), 255, dtype=np.uint8),
        _written(templates[1]),
        _written(templates[2]),
    ]
    result = process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래", "박균형"]),
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED
    assert "2번째" in (result.failure_reason or "")


def test_expected_student_count_mismatch_aborts(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    result = process_batch_pages(
        scan_pages=[_written(templates[1]), _written(templates[2])],
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형", "이자율"],
        local_ocr=FakeLocalOCR(["김미래"]),
        expected_students=3,
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED
    assert "명렬표" in (result.failure_reason or "")


def test_roster_count_is_enforced_by_default(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    result = process_batch_pages(
        scan_pages=[_written(templates[1]), _written(templates[2])],
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래", "박균형"],
        local_ocr=FakeLocalOCR(["김미래"]),
    )

    assert result.outcome == PipelineOutcome.SPLIT_FAILED


def test_progress_callback_is_monotonic_and_finishes(
    templates,
    crop_specs,
    pii_spec,
) -> None:
    calls: list[tuple[int, int, str]] = []
    process_batch_pages(
        scan_pages=[_written(templates[1]), _written(templates[2])],
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래"],
        local_ocr=FakeLocalOCR(["김미래"]),
        progress=lambda done, total, message: calls.append((done, total, message)),
    )

    assert [done for done, _total, _message in calls] == [1, 2]
    assert {total for _done, total, _message in calls} == {2}
    assert calls[-1][0] == calls[-1][1]


def test_response_region_overlapping_pii_is_rejected_before_ocr(
    templates,
    pii_spec,
) -> None:
    ocr = FakeLocalOCR(["김미래"])

    with pytest.raises(PIIBoundaryViolation):
        process_batch_pages(
            scan_pages=[_written(templates[1]), _written(templates[2])],
            templates=templates,
            pages_per_student=2,
            crop_specs={
                1: [CropSpec(item_no=1, x=150, y=150, width=100, height=50)]
            },
            pii_rect=pii_spec,
            roster=["김미래"],
            local_ocr=ocr,
        )

    assert ocr.calls == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"scan_pages": ()},
        {"templates": {1: _template_page(1)}},
        {"templates": {1: _template_page(1), 3: _template_page(3)}},
        {"crop_specs": {}},
        {"pii_rect": (3, (0, 0, 10, 10))},
        {"local_ocr": object()},
    ],
)
def test_rejects_invalid_pipeline_contract(
    templates,
    crop_specs,
    pii_spec,
    overrides,
) -> None:
    arguments = {
        "scan_pages": [_written(templates[1]), _written(templates[2])],
        "templates": templates,
        "pages_per_student": 2,
        "crop_specs": crop_specs,
        "pii_rect": pii_spec,
        "roster": ["김미래"],
        "local_ocr": FakeLocalOCR(["김미래"]),
    }
    arguments.update(overrides)

    with pytest.raises(ValueError, match="파이프라인"):
        process_batch_pages(**arguments)


def test_duplicate_item_numbers_across_pages_are_rejected(
    templates,
    pii_spec,
) -> None:
    with pytest.raises(ValueError, match="파이프라인"):
        process_batch_pages(
            scan_pages=[_written(templates[1]), _written(templates[2])],
            templates=templates,
            pages_per_student=2,
            crop_specs={
                1: [CropSpec(item_no=1, x=150, y=300, width=500, height=120)],
                2: [CropSpec(item_no=1, x=150, y=300, width=500, height=120)],
            },
            pii_rect=pii_spec,
            roster=["김미래"],
            local_ocr=FakeLocalOCR(["김미래"]),
        )


def test_input_scans_are_not_modified(templates, crop_specs, pii_spec) -> None:
    scans = [_written(templates[1]), _written(templates[2])]
    originals = [scan.copy() for scan in scans]

    process_batch_pages(
        scan_pages=scans,
        templates=templates,
        pages_per_student=2,
        crop_specs=crop_specs,
        pii_rect=pii_spec,
        roster=["김미래"],
        local_ocr=FakeLocalOCR(["김미래"]),
    )

    assert all(np.array_equal(scan, original) for scan, original in zip(scans, originals))
