from copy import deepcopy
from pathlib import Path

import pytest

from app.config import settings
from app.models import RubricDraft, SourceDocument
from app.providers.credentials import CredentialStoreError
from app.schemas.rubric import Rubric
from app.services.pdf_extract import PdfExtract, PdfPage
from app.services.rubric_compiler import CompileResult
from app.services.rubric_warnings import detect_warnings
from tests.test_rubric_compiler import VALID_RUBRIC


@pytest.fixture
def assessment_id(client):
    response = client.post(
        "/api/assessments",
        json={
            **VALID_RUBRIC["assessment"],
            "achievement_standards": VALID_RUBRIC["achievement_standards"],
            "level_cutoffs": VALID_RUBRIC["level_cutoffs"],
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


@pytest.fixture
def compile_document(db_session, assessment_id):
    path = settings.uploads_dir() / f"{'1' * 32}.pdf"
    path.write_bytes(b"local test pdf")
    document = SourceDocument(
        assessment_id=assessment_id,
        kind="rubric_table",
        filename="기준표.pdf",
        stored_path=str(path),
        page_count=1,
    )
    db_session.add(document)
    db_session.commit()
    return document


@pytest.fixture
def stub_compile(monkeypatch, compile_document):
    from app.api import rubrics

    rubric = Rubric.model_validate(VALID_RUBRIC)

    def fake(_assessment, _documents, _session):
        return CompileResult(
            rubric=rubric,
            errors=[],
            warnings=detect_warnings(rubric),
            attempts=1,
        )

    monkeypatch.setattr(rubrics, "run_compile", fake)


def _compile(client, assessment_id):
    return client.post(f"/api/assessments/{assessment_id}/rubric/compile")


def test_compile_stores_draft_warnings_and_status(
    client, db_session, assessment_id, stub_compile
):
    response = _compile(client, assessment_id)

    assert response.status_code == 200
    assert response.json()["errors"] == []
    assert response.json()["confirmed"] is False
    assert any(
        warning["code"] == "manual_review_required"
        for warning in response.json()["warnings"]
    )
    saved = db_session.query(RubricDraft).filter_by(
        assessment_id=assessment_id
    ).one()
    assert saved.content["items"][0]["item_no"] == 1
    assert client.get(f"/api/assessments/{assessment_id}").json()["status"] == "compiled"


def test_compile_uses_only_allowed_sources_in_stable_order(
    client, db_session, assessment_id, compile_document, monkeypatch
):
    from app.api import rubrics

    answer = SourceDocument(
        assessment_id=assessment_id,
        kind="answer_sheet",
        filename="답안.pdf",
        stored_path=str(settings.uploads_dir() / "ignored.pdf"),
        page_count=1,
    )
    example = SourceDocument(
        assessment_id=assessment_id,
        kind="example_answer",
        filename="예시.pdf",
        stored_path=str(settings.uploads_dir() / f"{'2' * 32}.pdf"),
        page_count=1,
    )
    db_session.add_all([answer, example])
    db_session.commit()
    seen: list[int] = []
    rubric = Rubric.model_validate(VALID_RUBRIC)

    def fake(_assessment, documents, _session):
        seen.extend(document.id for document in documents)
        return CompileResult(rubric=rubric)

    monkeypatch.setattr(rubrics, "run_compile", fake)

    response = _compile(client, assessment_id)

    assert response.status_code == 200
    assert seen == [compile_document.id, example.id]


def test_compile_requires_a_compile_source(client, assessment_id):
    response = _compile(client, assessment_id)

    assert response.status_code == 400
    assert response.json() == {
        "detail": "채점 기준표 또는 예시 답안 PDF를 먼저 올리세요."
    }


def test_answer_sheet_is_not_a_compile_source(client, db_session, assessment_id):
    db_session.add(
        SourceDocument(
            assessment_id=assessment_id,
            kind="answer_sheet",
            filename="학생답안.pdf",
            stored_path="/not-used/answer.pdf",
            page_count=1,
        )
    )
    db_session.commit()

    assert _compile(client, assessment_id).status_code == 400


def test_compile_without_rubric_returns_fixed_error_and_saves_nothing(
    client, db_session, assessment_id, compile_document, monkeypatch
):
    from app.api import rubrics

    monkeypatch.setattr(
        rubrics,
        "run_compile",
        lambda *_: CompileResult(
            rubric=None,
            errors=["provider-secret-output"],
            attempts=2,
        ),
    )

    response = _compile(client, assessment_id)

    assert response.status_code == 422
    assert response.json() == {"detail": "루브릭 초안을 만들지 못했습니다."}
    assert "provider-secret-output" not in response.text
    assert db_session.query(RubricDraft).count() == 0


def test_recompile_updates_one_draft(client, db_session, assessment_id, stub_compile):
    assert _compile(client, assessment_id).status_code == 200
    first_id = db_session.query(RubricDraft).one().id

    assert _compile(client, assessment_id).status_code == 200

    drafts = db_session.query(RubricDraft).all()
    assert [draft.id for draft in drafts] == [first_id]


def test_confirmed_rubric_must_be_unconfirmed_before_recompile(
    client, assessment_id, stub_compile
):
    _compile(client, assessment_id)
    client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    response = _compile(client, assessment_id)

    assert response.status_code == 409


def test_get_rubric_returns_saved_draft(client, assessment_id, stub_compile):
    _compile(client, assessment_id)

    response = client.get(f"/api/assessments/{assessment_id}/rubric")

    assert response.status_code == 200
    assert response.json()["rubric"]["items"][0]["item_no"] == 1


def test_get_rubric_before_compile_returns_404(client, assessment_id):
    assert client.get(f"/api/assessments/{assessment_id}/rubric").status_code == 404


def test_teacher_edit_is_saved_and_validated(client, assessment_id, stub_compile):
    _compile(client, assessment_id)
    broken = deepcopy(VALID_RUBRIC)
    broken["items"][0]["points"] = 99

    response = client.put(
        f"/api/assessments/{assessment_id}/rubric",
        json={"rubric": broken},
    )

    assert response.status_code == 200
    assert response.json()["rubric"]["items"][0]["points"] == 99
    assert any("배점 합계" in error for error in response.json()["errors"])


def test_teacher_edit_cannot_replace_assessment_authority(
    client, assessment_id, stub_compile
):
    _compile(client, assessment_id)
    changed = deepcopy(VALID_RUBRIC)
    changed["assessment"]["title"] = "바꾸려는 제목"
    changed["achievement_standards"] = []
    changed["level_cutoffs"] = {}

    response = client.put(
        f"/api/assessments/{assessment_id}/rubric",
        json={"rubric": changed},
    )

    assert response.status_code == 200
    rubric = response.json()["rubric"]
    assert rubric["assessment"] == VALID_RUBRIC["assessment"]
    assert rubric["achievement_standards"] == VALID_RUBRIC["achievement_standards"]
    assert rubric["level_cutoffs"] == VALID_RUBRIC["level_cutoffs"]


def test_get_and_confirm_use_latest_assessment_authority(
    client, assessment_id, stub_compile
):
    _compile(client, assessment_id)
    assert client.patch(
        f"/api/assessments/{assessment_id}",
        json={"title": "최신 평가 제목"},
    ).status_code == 200

    current = client.get(f"/api/assessments/{assessment_id}/rubric")
    confirmed = client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    assert current.json()["rubric"]["assessment"]["title"] == "최신 평가 제목"
    assert confirmed.status_code == 200
    assert confirmed.json()["rubric"]["assessment"]["title"] == "최신 평가 제목"


def test_changed_total_points_blocks_stale_rubric_confirmation(
    client, assessment_id, stub_compile
):
    _compile(client, assessment_id)
    assert client.patch(
        f"/api/assessments/{assessment_id}",
        json={
            "total_points": 5,
            "level_cutoffs": {"3": 5, "2": 3, "1": 0},
        },
    ).status_code == 200

    current = client.get(f"/api/assessments/{assessment_id}/rubric")
    confirmed = client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    assert any("배점 합계" in error for error in current.json()["errors"])
    assert confirmed.status_code == 400


def test_schema_error_is_safe_and_does_not_replace_valid_draft(
    client, assessment_id, stub_compile
):
    _compile(client, assessment_id)
    broken = deepcopy(VALID_RUBRIC)
    broken["items"][0]["scoring"][0]["condition"] = "private-marker"

    response = client.put(
        f"/api/assessments/{assessment_id}/rubric",
        json={"rubric": broken},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_rubric_shape"
    assert "private-marker" not in response.text
    saved = client.get(f"/api/assessments/{assessment_id}/rubric").json()
    assert saved["rubric"]["items"][0]["scoring"][0]["condition"] == "all_correct"


def test_update_rejects_extra_envelope_fields(client, assessment_id, stub_compile):
    _compile(client, assessment_id)

    response = client.put(
        f"/api/assessments/{assessment_id}/rubric",
        json={"rubric": VALID_RUBRIC, "unexpected": "value"},
    )

    assert response.status_code == 422


def test_confirm_requires_clean_rubric_with_fixed_error(
    client, assessment_id, stub_compile
):
    _compile(client, assessment_id)
    broken = deepcopy(VALID_RUBRIC)
    broken["items"][0]["title"] = "private-marker"
    broken["items"][0]["points"] = 99
    client.put(
        f"/api/assessments/{assessment_id}/rubric",
        json={"rubric": broken},
    )

    response = client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    assert response.status_code == 400
    assert response.json() == {
        "detail": "루브릭 오류를 먼저 해결해야 확정할 수 있습니다."
    }
    assert "private-marker" not in response.text


def test_confirm_locks_rubric_and_assessment(client, assessment_id, stub_compile):
    _compile(client, assessment_id)

    response = client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    assert response.status_code == 200
    assert response.json()["confirmed"] is True
    assert client.get(f"/api/assessments/{assessment_id}").json()["status"] == "confirmed"
    assert client.patch(
        f"/api/assessments/{assessment_id}", json={"title": "변경"}
    ).status_code == 409
    assert client.put(
        f"/api/assessments/{assessment_id}/rubric",
        json={"rubric": VALID_RUBRIC},
    ).status_code == 409


def test_unconfirm_unlocks_assessment_and_rubric(client, assessment_id, stub_compile):
    _compile(client, assessment_id)
    client.post(f"/api/assessments/{assessment_id}/rubric/confirm")

    response = client.post(f"/api/assessments/{assessment_id}/rubric/unconfirm")

    assert response.status_code == 200
    assert response.json()["confirmed"] is False
    assert client.patch(
        f"/api/assessments/{assessment_id}", json={"title": "변경"}
    ).status_code == 200


@pytest.mark.parametrize("suffix", ["rubric", "rubric/compile", "rubric/confirm", "rubric/unconfirm"])
def test_missing_assessment_returns_404(client, suffix):
    method = "get" if suffix == "rubric" else "post"
    response = getattr(client, method)(f"/api/assessments/999/{suffix}")

    assert response.status_code == 404
    assert response.json() == {"detail": "평가를 찾을 수 없습니다."}


def test_run_compile_uses_bound_runtime_safe_path_and_single_provider(
    db_session, assessment_id, compile_document, monkeypatch
):
    from app.api import rubrics

    assessment = rubrics.load_assessment(assessment_id, db_session)
    store = object()
    seen: dict[str, object] = {}
    extract = PdfExtract(
        source_path=Path(compile_document.stored_path),
        pages=[PdfPage(page_no=1, text="기준", image_png=b"png")],
    )

    monkeypatch.setattr(rubrics, "get_credential_store", lambda: store)
    monkeypatch.setattr(
        rubrics,
        "read_llm_runtime",
        lambda session, received: ("api-key", "models/safe")
        if received is store
        else (None, None),
    )
    monkeypatch.setattr(rubrics, "extract_pdf", lambda path: extract)

    def fake_provider(**kwargs):
        seen.update(kwargs)
        return "provider-handle"

    monkeypatch.setattr(rubrics, "create_gemini_provider", fake_provider)
    monkeypatch.setattr(
        rubrics,
        "compile_rubric",
        lambda provider, extracts, authority: CompileResult(
            rubric=authority.apply_to(Rubric.model_validate(VALID_RUBRIC))
        )
        if provider == "provider-handle" and extracts == [extract]
        else CompileResult(rubric=None),
    )

    result = rubrics.run_compile(assessment, [compile_document], db_session)

    assert result.rubric is not None
    assert seen["api_key"] == "api-key"
    assert seen["model"] == "models/safe"
    gateway = seen["gateway"]
    assert gateway._provider == "gemini"
    assert gateway._audit_log_path == settings.audit_log_path()


@pytest.mark.parametrize(
    ("runtime", "status_code"),
    [((None, None), 400), (("api-key", None), 400)],
)
def test_run_compile_requires_key_and_model(
    db_session, assessment_id, compile_document, monkeypatch, runtime, status_code
):
    from app.api import rubrics
    from fastapi import HTTPException

    assessment = rubrics.load_assessment(assessment_id, db_session)
    monkeypatch.setattr(rubrics, "get_credential_store", object)
    monkeypatch.setattr(rubrics, "read_llm_runtime", lambda *_: runtime)

    with pytest.raises(HTTPException) as caught:
        rubrics.run_compile(assessment, [compile_document], db_session)

    assert caught.value.status_code == status_code


def test_run_compile_sanitizes_credential_store_failure(
    db_session, assessment_id, compile_document, monkeypatch
):
    from app.api import rubrics
    from fastapi import HTTPException

    assessment = rubrics.load_assessment(assessment_id, db_session)
    monkeypatch.setattr(rubrics, "get_credential_store", object)

    def fail(*_):
        raise CredentialStoreError("private-marker")

    monkeypatch.setattr(rubrics, "read_llm_runtime", fail)

    with pytest.raises(HTTPException) as caught:
        rubrics.run_compile(assessment, [compile_document], db_session)

    assert caught.value.status_code == 503
    assert "private-marker" not in str(caught.value.detail)


@pytest.mark.parametrize("unsafe_kind", ["outside", "missing", "symlink"])
def test_run_compile_rejects_unsafe_saved_path(
    db_session, assessment_id, compile_document, monkeypatch, tmp_path, unsafe_kind
):
    from app.api import rubrics
    from fastapi import HTTPException

    assessment = rubrics.load_assessment(assessment_id, db_session)
    if unsafe_kind == "outside":
        compile_document.stored_path = str(tmp_path / "outside.pdf")
        Path(compile_document.stored_path).write_bytes(b"pdf")
    elif unsafe_kind == "missing":
        Path(compile_document.stored_path).unlink()
    else:
        target = tmp_path / "target.pdf"
        target.write_bytes(b"pdf")
        Path(compile_document.stored_path).unlink()
        Path(compile_document.stored_path).symlink_to(target)
    db_session.commit()
    monkeypatch.setattr(rubrics, "get_credential_store", object)
    monkeypatch.setattr(
        rubrics, "read_llm_runtime", lambda *_: ("api-key", "models/safe")
    )

    with pytest.raises(HTTPException) as caught:
        rubrics.run_compile(assessment, [compile_document], db_session)

    assert caught.value.status_code == 409
    assert str(compile_document.stored_path) not in str(caught.value.detail)
