import os
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Assessment, RubricDraft, SourceDocument


FULL_ASSESSMENT = {
    "title": "2026 초등 기본학력 평가 수학 논술형",
    "subject": "수학",
    "grade": 6,
    "total_points": 20,
    "achievement_standards": [
        {
            "id": "AS1",
            "item_range": [1, 4],
            "core_standard": "선대칭 도형과 점대칭 도형의 의미를 이해한다.",
            "levels": {"1": "시도", "2": "가능", "3": "정확"},
        }
    ],
    "level_cutoffs": {"3": 17, "2": 11, "1": 0},
}


def _create(client, **overrides):
    payload = {
        "title": "평가",
        "subject": "수학",
        "grade": 6,
        "total_points": 20,
    }
    payload.update(overrides)
    return client.post("/api/assessments", json=payload)


def _standard(**overrides):
    standard = {
        "id": "AS1",
        "item_range": [1, 4],
        "core_standard": "성취기준",
        "levels": {"1": "시도", "2": "가능", "3": "정확"},
    }
    standard.update(overrides)
    return standard


def _submit_standard_change(client, operation, standard):
    if operation == "create":
        return _create(client, achievement_standards=[standard])
    assessment_id = _create(client).json()["id"]
    return client.patch(
        f"/api/assessments/{assessment_id}",
        json={"achievement_standards": [standard]},
    )


def _submit_level_mapping(client, operation, field_name, invalid_key):
    if field_name == "level_cutoffs":
        changes = {"level_cutoffs": {invalid_key: 0}}
    else:
        changes = {
            "achievement_standards": [
                _standard(levels={invalid_key: "잘못된 수준"})
            ]
        }

    if operation == "create":
        return _create(client, **changes)
    assessment_id = _create(client).json()["id"]
    return client.patch(f"/api/assessments/{assessment_id}", json=changes)


def test_create_assessment_preserves_all_teacher_authored_fields(client):
    response = client.post("/api/assessments", json=FULL_ASSESSMENT)

    assert response.status_code == 201
    body = response.json()
    assert body["id"] > 0
    assert body["status"] == "draft"
    assert body["created_at"] is not None
    assert {
        key: body[key]
        for key in (
            "title",
            "subject",
            "grade",
            "total_points",
            "achievement_standards",
            "level_cutoffs",
        )
    } == FULL_ASSESSMENT


def test_list_assessments_returns_newest_first(client):
    first = _create(client, title="첫 평가").json()
    second = _create(client, title="둘째 평가").json()

    response = client.get("/api/assessments")

    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()] == [
        second["id"],
        first["id"],
    ]


def test_get_assessment_returns_saved_record(client):
    created = client.post("/api/assessments", json=FULL_ASSESSMENT).json()

    response = client.get(f"/api/assessments/{created['id']}")

    assert response.status_code == 200
    assert response.json() == created


def test_update_preserves_every_changed_teacher_authored_field(client):
    created = _create(client).json()
    changed = {
        "title": "바꾼 평가",
        "subject": "과학",
        "grade": 5,
        "total_points": 30,
        "achievement_standards": FULL_ASSESSMENT["achievement_standards"],
        "level_cutoffs": {"3": 25, "2": 15, "1": 0},
    }

    response = client.patch(f"/api/assessments/{created['id']}", json=changed)

    assert response.status_code == 200
    assert {key: response.json()[key] for key in changed} == changed
    saved = client.get(f"/api/assessments/{created['id']}").json()
    assert {key: saved[key] for key in changed} == changed


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize(
    "standard",
    [
        _standard(unexpected="교사 원문"),
        _standard(item_range=["1", 4]),
        _standard(item_range=[True, 4]),
    ],
    ids=["extra-field", "string-item-range", "boolean-item-range"],
)
def test_create_and_update_reject_lossy_achievement_standard_input(
    client, operation, standard
):
    response = _submit_standard_change(client, operation, standard)

    assert response.status_code == 422


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize(
    "field_name", ["level_cutoffs", "achievement_levels"]
)
@pytest.mark.parametrize("invalid_key", ["03", "4", "0", "-1"])
def test_create_and_update_reject_level_keys_outside_the_closed_set(
    client, operation, field_name, invalid_key
):
    response = _submit_level_mapping(
        client, operation, field_name, invalid_key
    )

    assert response.status_code == 422


@pytest.mark.parametrize("method", ["get", "patch", "delete"])
def test_missing_assessment_returns_404(client, method):
    request = getattr(client, method)
    arguments = {"json": {"title": "바꿈"}} if method == "patch" else {}

    response = request("/api/assessments/999", **arguments)

    assert response.status_code == 404
    assert response.json() == {"detail": "평가를 찾을 수 없습니다."}


@pytest.mark.parametrize(
    "changes",
    [
        {"title": "   "},
        {"subject": ""},
        {"grade": 0},
        {"grade": 13},
        {"total_points": 0},
        {"unexpected": "value"},
        {"achievement_standards": [{"id": " "}]},
    ],
)
def test_create_rejects_invalid_input_without_echoing_internal_state(
    client, changes
):
    response = _create(client, **changes)

    assert response.status_code == 422
    assert "sqlite" not in response.text.lower()
    assert "traceback" not in response.text.lower()


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"subject": "   "},
        {"grade": 13},
        {"total_points": 0},
        {"unexpected": "value"},
    ],
)
def test_update_rejects_invalid_input(client, payload):
    created = _create(client).json()

    response = client.patch(f"/api/assessments/{created['id']}", json=payload)

    assert response.status_code == 422


def test_create_rejects_level_cutoffs_outside_total_points(client):
    response = _create(client, level_cutoffs={"3": 21, "2": 11, "1": 0})

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_level_cutoffs"


def test_update_rejects_total_points_that_invalidate_saved_cutoffs(client):
    created = _create(
        client, level_cutoffs={"3": 17, "2": 11, "1": 0}
    ).json()

    response = client.patch(
        f"/api/assessments/{created['id']}", json={"total_points": 10}
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_level_cutoffs"
    assert client.get(f"/api/assessments/{created['id']}").json()[
        "total_points"
    ] == 20


def test_delete_assessment_cascades_database_rows(client, db_session):
    assessment_id = _create(client).json()["id"]
    document = SourceDocument(
        assessment_id=assessment_id,
        kind="rubric_table",
        filename="없어진 원본.pdf",
        stored_path="/not-present/rubric.pdf",
        page_count=1,
    )
    draft = RubricDraft(assessment_id=assessment_id, content={"items": []})
    db_session.add_all([document, draft])
    db_session.commit()
    document_id = document.id
    draft_id = draft.id

    response = client.delete(f"/api/assessments/{assessment_id}")

    assert response.status_code == 204
    assert response.content == b""
    db_session.expire_all()
    assert db_session.get(Assessment, assessment_id) is None
    assert db_session.get(SourceDocument, document_id) is None
    assert db_session.get(RubricDraft, draft_id) is None


def test_delete_is_blocked_when_a_linked_local_file_exists(
    client, db_session, tmp_path
):
    assessment_id = _create(client).json()["id"]
    stored_file = tmp_path / "uploads" / "rubric.pdf"
    stored_file.parent.mkdir()
    stored_file.write_bytes(b"local source")
    document = SourceDocument(
        assessment_id=assessment_id,
        kind="rubric_table",
        filename="원본.pdf",
        stored_path=str(stored_file),
        page_count=1,
    )
    db_session.add(document)
    db_session.commit()

    response = client.delete(f"/api/assessments/{assessment_id}")

    assert response.status_code == 409
    assert response.json() == {
        "detail": "연결된 로컬 문서 파일을 먼저 안전하게 정리해야 합니다."
    }
    assert Path(stored_file).read_bytes() == b"local source"
    db_session.expire_all()
    assert db_session.get(Assessment, assessment_id) is not None
    assert db_session.get(SourceDocument, document.id) is not None


def test_delete_blocks_every_local_path_state_other_than_missing(
    client, db_session, tmp_path
):
    regular_file = tmp_path / "regular.pdf"
    regular_file.write_bytes(b"source")
    directory = tmp_path / "document-directory"
    directory.mkdir()
    dangling_link = tmp_path / "dangling.pdf"
    dangling_link.symlink_to(tmp_path / "missing-target.pdf")
    stored_paths = [
        str(regular_file),
        str(directory),
        str(dangling_link),
        "\0invalid-local-path",
    ]

    for stored_path in stored_paths:
        assessment_id = _create(client).json()["id"]
        document = SourceDocument(
            assessment_id=assessment_id,
            kind="rubric_table",
            filename="원본.pdf",
            stored_path=stored_path,
            page_count=1,
        )
        db_session.add(document)
        db_session.commit()

        response = client.delete(f"/api/assessments/{assessment_id}")

        assert response.status_code == 409
        assert response.json() == {
            "detail": "연결된 로컬 문서 파일을 먼저 안전하게 정리해야 합니다."
        }
        db_session.expire_all()
        assert db_session.get(Assessment, assessment_id) is not None
        assert db_session.get(SourceDocument, document.id) is not None


def test_delete_keeps_database_and_file_reference_when_status_lookup_fails(
    client, db_session, tmp_path, monkeypatch
):
    stored_file = tmp_path / "private-reference.pdf"
    stored_file.write_bytes(b"teacher source")
    assessment_id = _create(client).json()["id"]
    document = SourceDocument(
        assessment_id=assessment_id,
        kind="rubric_table",
        filename="원본.pdf",
        stored_path=str(stored_file),
        page_count=1,
    )
    db_session.add(document)
    db_session.commit()

    status_lookups = []

    def deny_status(path, *args, **kwargs):
        status_lookups.append(path)
        raise PermissionError(f"private failure for {stored_file}")

    with monkeypatch.context() as patch:
        patch.setattr(os, "stat", deny_status)
        patch.setattr(os, "lstat", deny_status)
        response = client.delete(f"/api/assessments/{assessment_id}")

    assert response.status_code == 409
    assert response.json() == {
        "detail": "연결된 로컬 문서 파일을 먼저 안전하게 정리해야 합니다."
    }
    assert str(stored_file) not in response.text
    assert "private failure" not in response.text
    assert len(status_lookups) == 1
    assert stored_file.read_bytes() == b"teacher source"
    db_session.expire_all()
    assert db_session.get(Assessment, assessment_id) is not None
    assert db_session.get(SourceDocument, document.id) is not None


def test_database_integrity_error_is_rolled_back_and_sanitized(
    client, db_session, monkeypatch
):
    def fail_commit():
        raise IntegrityError(
            "secret sql statement",
            {"private": "database detail"},
            RuntimeError("private driver failure"),
        )

    monkeypatch.setattr(db_session, "commit", fail_commit)

    response = _create(client)

    assert response.status_code == 409
    assert response.json() == {
        "detail": "자료 무결성 제약으로 요청을 처리할 수 없습니다."
    }
    assert "secret sql statement" not in response.text
    assert "database detail" not in response.text
    assert "private driver failure" not in response.text
    assert db_session.in_transaction() is False
