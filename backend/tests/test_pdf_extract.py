import fitz  # PyMuPDF
import pytest

from app.services.pdf_extract import RENDER_ZOOM, extract_pdf


def _zero_page_pdf() -> bytes:
    objects = [
        b"%PDF-1.4\n",
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
    ]
    offsets: list[int] = []
    position = 0
    for obj in objects:
        if obj.startswith((b"1 ", b"2 ")):
            offsets.append(position)
        position += len(obj)
    xref = b"xref\n0 3\n0000000000 65535 f \n" + b"".join(
        f"{offset:010d} 00000 n \n".encode() for offset in offsets
    )
    startxref = position + len(xref)
    return b"".join(objects) + xref + (
        b"trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n"
        + str(startxref).encode()
        + b"\n%%EOF\n"
    )


@pytest.fixture
def sample_pdf(tmp_path):
    path = tmp_path / "sample.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "chaejeom criteria", fontsize=14)
    doc.new_page().insert_text((72, 100), "second page", fontsize=14)
    doc.save(path)
    doc.close()
    return path


def test_extract_returns_one_entry_per_page(sample_pdf):
    result = extract_pdf(sample_pdf)

    assert result.page_count == 2
    assert len(result.pages) == 2
    assert [page.page_no for page in result.pages] == [1, 2]


def test_extract_returns_text_and_png_image(sample_pdf):
    result = extract_pdf(sample_pdf)
    first = result.pages[0]

    assert "chaejeom" in first.text
    assert first.image_png.startswith(b"\x89PNG")


def test_extract_renders_pages_at_configured_zoom(sample_pdf):
    result = extract_pdf(sample_pdf)
    image = fitz.Pixmap(result.pages[0].image_png)

    assert image.width == pytest.approx(595 * RENDER_ZOOM, abs=1)
    assert image.height == pytest.approx(842 * RENDER_ZOOM, abs=1)


def test_full_text_joins_pages_in_order(sample_pdf):
    result = extract_pdf(sample_pdf)

    assert result.full_text().index("chaejeom") < result.full_text().index("second")


def test_extract_empty_document_returns_no_pages(tmp_path):
    path = tmp_path / "empty.pdf"
    path.write_bytes(_zero_page_pdf())

    result = extract_pdf(path)

    assert result.source_path == path
    assert result.page_count == 0
    assert result.pages == []
    assert result.full_text() == ""


def test_extract_blank_page_keeps_page_and_empty_text(tmp_path):
    path = tmp_path / "blank.pdf"
    document = fitz.open()
    document.new_page()
    document.save(path)
    document.close()

    result = extract_pdf(path)

    assert result.page_count == 1
    assert result.pages[0].text == ""
    assert result.pages[0].image_png.startswith(b"\x89PNG")
