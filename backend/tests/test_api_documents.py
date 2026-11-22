import os
import stat
from pathlib import Path

import fitz
import pytest
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.models.document import SourceDocument


@pytest.fixture
def pdf_bytes() -> bytes:
    document = fitz.open()
    document.new_page().insert_text((72, 100), "rubric table", fontsize=12)
    data = document.tobytes()
    document.close()
    return data


@pytest.fixture
def assessment_id(client) -> int:
    response = client.post(
        "/api/assessments",
        json={"title": "평가", "subject": "수학", "grade": 6, "total_points": 20},
    )
    assert response.status_code == 201
    return response.json()["id"]


def _upload(client, assessment_id: int, content: bytes, **overrides):
    kind = overrides.pop("kind", "rubric_table")
    filename = overrides.pop("filename", "rubric.pdf")
    content_type = overrides.pop("content_type", "application/pdf")
    assert not overrides
    return client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": kind},
        files={"file": (filename, content, content_type)},
    )


def test_upload_pdf_records_page_count_and_private_local_file(
    client, db_session, assessment_id, pdf_bytes
):
    response = _upload(client, assessment_id, pdf_bytes)

    assert response.status_code == 201
    assert response.json() == {
        "id": response.json()["id"],
        "kind": "rubric_table",
        "filename": "rubric.pdf",
        "page_count": 1,
    }
    record = db_session.get(SourceDocument, response.json()["id"])
    assert record is not None
    stored_path = Path(record.stored_path)
    assert stored_path.parent == settings.uploads_dir()
    assert stored_path.name != "rubric.pdf"
    assert stored_path.suffix == ".pdf"
    assert stored_path.read_bytes() == pdf_bytes
    assert stat.S_IMODE(stored_path.stat().st_mode) == 0o600


def test_list_documents_is_ordered_and_does_not_expose_local_paths(
    client, assessment_id, pdf_bytes
):
    first = _upload(client, assessment_id, pdf_bytes, kind="rubric_table").json()
    second = _upload(client, assessment_id, pdf_bytes, kind="example_answer").json()

    response = client.get(f"/api/assessments/{assessment_id}/documents")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [first["id"], second["id"]]
    assert all("stored_path" not in item for item in response.json())


@pytest.mark.parametrize("method", ["get", "post"])
def test_missing_assessment_returns_fixed_404(client, pdf_bytes, method):
    if method == "get":
        response = client.get("/api/assessments/999/documents")
    else:
        response = _upload(client, 999, pdf_bytes)

    assert response.status_code == 404
    assert response.json() == {"detail": "평가를 찾을 수 없습니다."}


def test_rejects_unknown_kind_without_echoing_input(client, assessment_id, pdf_bytes):
    response = _upload(
        client,
        assessment_id,
        pdf_bytes,
        kind="학생이름-비밀-종류",
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "알 수 없는 문서 종류입니다."}
    assert "학생이름" not in response.text


@pytest.mark.parametrize(
    ("content", "filename", "content_type"),
    [
        (b"hello", "x.txt", "text/plain"),
        (b"%PDF-not-a-real-pdf", "x.pdf", "application/pdf"),
        (b"", "empty.pdf", "application/pdf"),
    ],
)
def test_rejects_invalid_pdf_and_leaves_no_file(
    client, assessment_id, content, filename, content_type
):
    response = _upload(
        client,
        assessment_id,
        content,
        filename=filename,
        content_type=content_type,
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "올바른 PDF 파일만 올릴 수 있습니다."}
    assert list(settings.uploads_dir().iterdir()) == []


def test_rejects_encrypted_pdf(client, assessment_id):
    document = fitz.open()
    document.new_page()
    encrypted = document.tobytes(
        encryption=fitz.PDF_ENCRYPT_AES_256,
        owner_pw="owner-secret",
        user_pw="user-secret",
    )
    document.close()

    response = _upload(client, assessment_id, encrypted)

    assert response.status_code == 400
    assert response.json() == {"detail": "암호화되지 않은 PDF 파일만 올릴 수 있습니다."}
    assert list(settings.uploads_dir().iterdir()) == []


def test_rejects_oversized_upload_before_persisting(
    client, assessment_id, pdf_bytes, monkeypatch
):
    from app.api import documents

    monkeypatch.setattr(documents, "MAX_PDF_BYTES", len(pdf_bytes) - 1)

    response = _upload(client, assessment_id, pdf_bytes)

    assert response.status_code == 413
    assert response.json() == {"detail": "PDF 파일 크기 제한을 넘었습니다."}
    assert list(settings.uploads_dir().iterdir()) == []


def test_original_filename_is_display_only_and_cannot_choose_storage_path(
    client, db_session, assessment_id, pdf_bytes, tmp_path
):
    response = _upload(
        client,
        assessment_id,
        pdf_bytes,
        filename="../../outside.pdf",
    )

    assert response.status_code == 201
    assert response.json()["filename"] == "outside.pdf"
    record = db_session.get(SourceDocument, response.json()["id"])
    assert record is not None
    assert Path(record.stored_path).parent == settings.uploads_dir()
    assert not (tmp_path / "outside.pdf").exists()


def test_database_failure_rolls_back_and_removes_written_file(
    client, db_session, assessment_id, pdf_bytes, monkeypatch
):
    def fail_commit():
        raise IntegrityError("statement-secret", {}, RuntimeError("database-secret"))

    monkeypatch.setattr(db_session, "commit", fail_commit)

    response = _upload(client, assessment_id, pdf_bytes)

    assert response.status_code == 409
    assert response.json() == {
        "detail": "자료 무결성 제약으로 문서를 저장하지 못했습니다."
    }
    assert "secret" not in response.text
    assert list(settings.uploads_dir().iterdir()) == []
    assert db_session.query(SourceDocument).count() == 0


def test_upload_directory_symlink_is_rejected_without_writing_outside(
    client, assessment_id, pdf_bytes, tmp_path
):
    uploads = settings.uploads_dir()
    uploads.rmdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    uploads.symlink_to(outside, target_is_directory=True)

    response = _upload(client, assessment_id, pdf_bytes)

    assert response.status_code == 500
    assert response.json() == {"detail": "로컬 문서 저장소를 안전하게 사용할 수 없습니다."}
    assert list(outside.iterdir()) == []


def test_upload_read_failure_leaves_no_temporary_file(
    client, assessment_id, pdf_bytes, monkeypatch
):
    from app.api import documents

    original_write = documents.os.write
    calls = 0

    def fail_second_write(descriptor, data):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("private-write-error")
        return original_write(descriptor, data[: max(1, len(data) // 2)])

    monkeypatch.setattr(documents.os, "write", fail_second_write)

    response = _upload(client, assessment_id, pdf_bytes)

    assert response.status_code == 500
    assert response.json() == {"detail": "PDF 파일을 안전하게 저장하지 못했습니다."}
    assert "private-write-error" not in response.text
    assert list(settings.uploads_dir().iterdir()) == []

