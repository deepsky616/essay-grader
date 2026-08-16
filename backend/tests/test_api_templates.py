from pathlib import Path
import stat

import fitz
import pytest

from app.config import settings
from app.models.document import SourceDocument
from app.models.sheet_template import SheetTemplate


@pytest.fixture
def assessment_id(client) -> int:
    response = client.post(
        "/api/assessments",
        json={"title": "평가", "subject": "수학", "grade": 6, "total_points": 20},
    )
    assert response.status_code == 201
    return response.json()["id"]


@pytest.fixture
def sheet_pdf() -> bytes:
    document = fitz.open()
    for _ in range(2):
        document.new_page(width=595, height=842)
    data = document.tobytes()
    document.close()
    return data


def _upload_sheet(client, assessment_id: int, content: bytes):
    return client.post(
        f"/api/assessments/{assessment_id}/documents",
        data={"kind": "answer_sheet"},
        files={"file": ("sheet.pdf", content, "application/pdf")},
    )


@pytest.fixture
def template_id(client, assessment_id, sheet_pdf) -> int:
    uploaded = _upload_sheet(client, assessment_id, sheet_pdf)
    assert uploaded.status_code == 201
    created = client.post(f"/api/assessments/{assessment_id}/template")
    assert created.status_code == 200
    return created.json()["id"]


def _regions(pii: bool = True) -> dict[str, list[dict[str, object]]]:
    values: list[dict[str, object]] = []
    if pii:
        values.append(
            {
                "region_type": "pii",
                "item_no": None,
                "page_no": 1,
                "x": 50,
                "y": 50,
                "width": 400,
                "height": 60,
            }
        )
    values.append(
        {
            "region_type": "response",
            "item_no": 1,
            "page_no": 1,
            "x": 60,
            "y": 200,
            "width": 400,
            "height": 100,
        }
    )
    return {"regions": values}


def test_create_template_from_answer_sheet(client, assessment_id, template_id) -> None:
    response = client.post(f"/api/assessments/{assessment_id}/template")

    assert response.status_code == 200
    assert response.json() == {
        "id": template_id,
        "page_count": 2,
        "dpi": 200,
        "printable_ready": False,
    }


def test_template_requires_answer_sheet_document(client, assessment_id) -> None:
    response = client.post(f"/api/assessments/{assessment_id}/template")

    assert response.status_code == 400
    assert "빈 답안지" in response.json()["detail"]


def test_missing_assessment_returns_404(client) -> None:
    response = client.post("/api/assessments/999/template")

    assert response.status_code == 404


def test_page_images_are_served_privately(client, assessment_id, template_id) -> None:
    response = client.get(f"/api/assessments/{assessment_id}/template/pages/1")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.content.startswith(b"\x89PNG")


def test_missing_page_returns_404(client, assessment_id, template_id) -> None:
    assert (
        client.get(f"/api/assessments/{assessment_id}/template/pages/3").status_code
        == 404
    )


def test_save_and_read_regions(client, assessment_id, template_id) -> None:
    response = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json=_regions(),
    )

    assert response.status_code == 200
    assert response.json() == {"saved": 2}
    loaded = client.get(f"/api/assessments/{assessment_id}/template/regions")
    assert loaded.status_code == 200
    assert loaded.json()["regions"] == _regions()["regions"]


def test_response_region_overlapping_pii_is_rejected(
    client,
    assessment_id,
    template_id,
) -> None:
    response = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={
            "regions": [
                {
                    "region_type": "pii",
                    "item_no": None,
                    "page_no": 1,
                    "x": 50,
                    "y": 50,
                    "width": 400,
                    "height": 200,
                },
                {
                    "region_type": "response",
                    "item_no": 1,
                    "page_no": 1,
                    "x": 100,
                    "y": 100,
                    "width": 200,
                    "height": 100,
                },
            ]
        },
    )

    assert response.status_code == 400
    assert "겹칩" in response.json()["detail"]


@pytest.mark.parametrize(
    "region",
    [
        {
            "region_type": "response",
            "item_no": None,
            "page_no": 1,
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
        },
        {
            "region_type": "pii",
            "item_no": 1,
            "page_no": 1,
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
        },
        {
            "region_type": "response",
            "item_no": 1,
            "page_no": 3,
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
        },
        {
            "region_type": "response",
            "item_no": 1,
            "page_no": 1,
            "x": 1600,
            "y": 0,
            "width": 100,
            "height": 10,
        },
    ],
)
def test_invalid_region_is_rejected(
    client,
    assessment_id,
    template_id,
    region,
) -> None:
    response = client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json={"regions": [region]},
    )

    assert response.status_code in {400, 422}


def test_duplicate_response_item_and_multiple_pii_are_rejected(
    client,
    assessment_id,
    template_id,
) -> None:
    duplicated = _regions()["regions"] + [
        {
            "region_type": "response",
            "item_no": 1,
            "page_no": 2,
            "x": 60,
            "y": 200,
            "width": 400,
            "height": 100,
        }
    ]
    assert (
        client.put(
            f"/api/assessments/{assessment_id}/template/regions",
            json={"regions": duplicated},
        ).status_code
        == 400
    )

    multiple_pii = _regions()["regions"] + [
        {
            "region_type": "pii",
            "item_no": None,
            "page_no": 2,
            "x": 50,
            "y": 50,
            "width": 400,
            "height": 60,
        }
    ]
    assert (
        client.put(
            f"/api/assessments/{assessment_id}/template/regions",
            json={"regions": multiple_pii},
        ).status_code
        == 400
    )


def test_region_replacement_is_atomic_on_validation_error(
    client,
    assessment_id,
    template_id,
) -> None:
    path = f"/api/assessments/{assessment_id}/template/regions"
    assert client.put(path, json=_regions()).status_code == 200

    rejected = client.put(
        path,
        json={
            "regions": [
                {
                    "region_type": "response",
                    "item_no": 2,
                    "page_no": 9,
                    "x": 0,
                    "y": 0,
                    "width": 10,
                    "height": 10,
                }
            ]
        },
    )

    assert rejected.status_code == 400
    assert client.get(path).json()["regions"] == _regions()["regions"]


def test_printable_sheet_is_generated_as_private_file(
    client,
    assessment_id,
    template_id,
    db_session,
) -> None:
    client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json=_regions(),
    )
    response = client.post(f"/api/assessments/{assessment_id}/template/printable")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    download = client.get(f"/api/assessments/{assessment_id}/template/printable")
    assert download.status_code == 200
    assert download.content.startswith(b"%PDF")
    template = db_session.get(SheetTemplate, template_id)
    output = Path(template.printable_path)
    assert output.parent == settings.uploads_dir()
    assert stat.S_IMODE(output.stat().st_mode) == 0o600


def test_printable_requires_response_region(client, assessment_id, template_id) -> None:
    assert (
        client.post(
            f"/api/assessments/{assessment_id}/template/printable"
        ).status_code
        == 400
    )


def test_printable_requires_pii_region(
    client, assessment_id, template_id
) -> None:
    client.put(
        f"/api/assessments/{assessment_id}/template/regions",
        json=_regions(pii=False),
    )

    response = client.post(
        f"/api/assessments/{assessment_id}/template/printable"
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "식별정보 영역을 하나 지정하세요."
    }


def test_download_requires_generated_regular_file(
    client,
    assessment_id,
    template_id,
    db_session,
    tmp_path,
) -> None:
    path = f"/api/assessments/{assessment_id}/template/printable"
    assert client.get(path).status_code == 404

    template = db_session.get(SheetTemplate, template_id)
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"%PDF-secret")
    template.printable_path = str(outside)
    db_session.commit()

    response = client.get(path)
    assert response.status_code == 404
    assert str(outside) not in response.text


def test_new_answer_sheet_invalidates_regions_and_printable(
    client,
    assessment_id,
    template_id,
) -> None:
    regions_path = f"/api/assessments/{assessment_id}/template/regions"
    client.put(regions_path, json=_regions())
    second = fitz.open()
    second.new_page(width=595, height=842)
    second_bytes = second.tobytes()
    second.close()
    assert _upload_sheet(client, assessment_id, second_bytes).status_code == 201

    recreated = client.post(f"/api/assessments/{assessment_id}/template")

    assert recreated.status_code == 200
    assert recreated.json()["id"] == template_id
    assert recreated.json()["page_count"] == 1
    assert recreated.json()["printable_ready"] is False
    assert client.get(regions_path).json()["regions"] == []


def test_tampered_source_path_is_rejected_without_exposure(
    client,
    assessment_id,
    template_id,
    db_session,
    tmp_path,
) -> None:
    template = db_session.get(SheetTemplate, template_id)
    document = db_session.get(SourceDocument, template.source_document_id)
    outside = tmp_path / "private-student-sheet.pdf"
    outside.write_bytes(Path(document.stored_path).read_bytes())
    document.stored_path = str(outside)
    db_session.commit()

    response = client.get(f"/api/assessments/{assessment_id}/template/pages/1")

    assert response.status_code == 400
    assert str(outside) not in response.text
