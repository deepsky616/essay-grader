from pathlib import Path

import fitz
import numpy as np
import pytest

from app.services.markers import detect_page_markers
from app.services.sheet_builder import MARKER_SIZE_PT, build_printable_sheet


@pytest.fixture
def plain_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "plain.pdf"
    document = fitz.open()
    for index in range(3):
        page = document.new_page(width=595, height=842)
        page.insert_text((72, 100), f"page {index + 1}", fontsize=14)
    document.save(path)
    document.close()
    return path


def test_output_keeps_page_count(plain_pdf: Path, tmp_path: Path) -> None:
    output = tmp_path / "printable.pdf"
    returned = build_printable_sheet(plain_pdf, output, regions=[])

    assert returned == output
    with fitz.open(output) as document:
        assert document.page_count == 3


def test_markers_are_detectable_on_each_page(
    plain_pdf: Path,
    tmp_path: Path,
) -> None:
    output = tmp_path / "printable.pdf"
    build_printable_sheet(plain_pdf, output, regions=[])

    with fitz.open(output) as document:
        for index, page in enumerate(document):
            pixmap = page.get_pixmap(dpi=200, alpha=False)
            image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height,
                pixmap.width,
                pixmap.n,
            )
            detected = detect_page_markers(image[:, :, :3])
            assert detected is not None
            assert detected.page_no == index + 1
            assert detected.is_complete


def test_response_boxes_are_drawn(plain_pdf: Path, tmp_path: Path) -> None:
    output = tmp_path / "printable.pdf"
    build_printable_sheet(
        plain_pdf,
        output,
        regions=[
            {
                "page_no": 1,
                "x": 100.0,
                "y": 300.0,
                "width": 380.0,
                "height": 120.0,
            }
        ],
    )

    with fitz.open(output) as document:
        assert len(document[0].get_drawings()) >= 5
        assert len(document[1].get_drawings()) >= 4


def test_rejects_document_exceeding_marker_capacity(tmp_path: Path) -> None:
    source = tmp_path / "huge.pdf"
    document = fitz.open()
    for _ in range(63):
        document.new_page(width=595, height=842)
    document.save(source)
    document.close()

    with pytest.raises(ValueError, match="쪽 번호"):
        build_printable_sheet(source, tmp_path / "out.pdf", regions=[])


def test_marker_size_is_large_enough_to_scan() -> None:
    px_at_200dpi = MARKER_SIZE_PT / 72 * 200
    assert px_at_200dpi >= 50


@pytest.mark.parametrize(
    "region",
    [
        {"page_no": True, "x": 100, "y": 200, "width": 100, "height": 50},
        {"page_no": 4, "x": 100, "y": 200, "width": 100, "height": 50},
        {"page_no": 1, "x": float("nan"), "y": 200, "width": 100, "height": 50},
        {"page_no": 1, "x": -1, "y": 200, "width": 100, "height": 50},
        {"page_no": 1, "x": 100, "y": 200, "width": 0, "height": 50},
        {"page_no": 1, "x": 550, "y": 200, "width": 100, "height": 50},
        {"page_no": 1, "x": 10, "y": 10, "width": 60, "height": 60},
    ],
)
def test_rejects_unsafe_region(
    plain_pdf: Path,
    tmp_path: Path,
    region: dict[str, object],
) -> None:
    output = tmp_path / "printable.pdf"

    with pytest.raises(ValueError, match="응답 영역"):
        build_printable_sheet(plain_pdf, output, regions=[region])

    assert not output.exists()


def test_rejects_missing_region_field(plain_pdf: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="응답 영역"):
        build_printable_sheet(
            plain_pdf,
            tmp_path / "out.pdf",
            regions=[{"page_no": 1, "x": 100, "y": 200, "width": 100}],
        )


def test_rejects_empty_or_tiny_document(tmp_path: Path) -> None:
    empty = tmp_path / "empty.pdf"
    empty.write_bytes(b"")

    with pytest.raises(ValueError, match="원본 답안지"):
        build_printable_sheet(empty, tmp_path / "empty-out.pdf", regions=[])

    tiny = tmp_path / "tiny.pdf"
    document = fitz.open()
    document.new_page(width=60, height=60)
    document.save(tiny)
    document.close()

    with pytest.raises(ValueError, match="답안지"):
        build_printable_sheet(tiny, tmp_path / "tiny-out.pdf", regions=[])


def test_rejects_same_source_and_output(plain_pdf: Path) -> None:
    original = plain_pdf.read_bytes()

    with pytest.raises(ValueError, match="출력"):
        build_printable_sheet(plain_pdf, plain_pdf, regions=[])

    assert plain_pdf.read_bytes() == original


def test_failed_build_preserves_existing_output(
    plain_pdf: Path,
    tmp_path: Path,
) -> None:
    output = tmp_path / "printable.pdf"
    output.write_bytes(b"keep-me")

    with pytest.raises(ValueError, match="응답 영역"):
        build_printable_sheet(
            plain_pdf,
            output,
            regions=[
                {"page_no": 1, "x": 570, "y": 300, "width": 50, "height": 50}
            ],
        )

    assert output.read_bytes() == b"keep-me"


def test_rejects_missing_source_without_exposing_path(tmp_path: Path) -> None:
    missing = tmp_path / "private-student-name.pdf"

    with pytest.raises(ValueError, match="원본 답안지") as caught:
        build_printable_sheet(missing, tmp_path / "out.pdf", regions=[])

    assert str(missing) not in str(caught.value)
