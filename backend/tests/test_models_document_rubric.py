import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Assessment, Base, RubricDraft, SourceDocument


def _assessment(db_session, title: str = "평가") -> Assessment:
    assessment = Assessment(
        title=title,
        subject="수학",
        grade=6,
        total_points=20,
    )
    db_session.add(assessment)
    db_session.commit()
    return assessment


def test_model_package_exports_document_and_rubric_models():
    assert SourceDocument.__table__.metadata is Base.metadata
    assert RubricDraft.__table__.metadata is Base.metadata


def test_source_document_persists_with_relationship_and_timestamps(db_session):
    assessment = _assessment(db_session)
    document = SourceDocument(
        assessment_id=assessment.id,
        kind="rubric_table",
        filename="채점기준표.pdf",
        stored_path="/local/uploads/rubric.pdf",
        page_count=3,
    )
    db_session.add(document)
    db_session.commit()
    db_session.expunge_all()

    loaded = db_session.scalar(select(SourceDocument))
    assert loaded is not None
    assert loaded.kind == "rubric_table"
    assert loaded.page_count == 3
    assert loaded.assessment.title == "평가"
    assert loaded.created_at is not None
    assert loaded.updated_at is not None


def test_rubric_draft_defaults_are_isolated_and_relationship_is_one_to_one(
    db_session,
):
    first_assessment = _assessment(db_session, "첫 평가")
    second_assessment = _assessment(db_session, "둘째 평가")
    first = RubricDraft(
        assessment_id=first_assessment.id,
        content={"items": []},
    )
    second = RubricDraft(
        assessment_id=second_assessment.id,
        content={"items": []},
    )
    db_session.add_all([first, second])
    db_session.commit()

    first.warnings.append({"code": "symbol_mismatch"})
    db_session.commit()
    db_session.expunge_all()

    loaded_first = db_session.get(Assessment, first_assessment.id)
    loaded_second = db_session.get(Assessment, second_assessment.id)
    assert loaded_first.rubric_draft.confirmed is False
    assert loaded_first.rubric_draft.warnings == [
        {"code": "symbol_mismatch"}
    ]
    assert loaded_second.rubric_draft.warnings == []


def test_nested_in_place_rubric_changes_persist(db_session):
    assessment = _assessment(db_session)
    draft = RubricDraft(
        assessment_id=assessment.id,
        content={
            "assessment": {"title": "바꾸기 전"},
            "items": [{"item_no": 1, "answers": ["가"]}],
        },
        warnings=[{"code": "first", "details": {"symbols": ["가"]}}],
    )
    db_session.add(draft)
    db_session.commit()

    draft.content["assessment"]["title"] = "바꾼 뒤"
    draft.content["items"][0]["answers"].append("나")
    draft.warnings[0]["details"]["symbols"].append("나")
    db_session.commit()
    db_session.expunge_all()

    loaded = db_session.get(RubricDraft, draft.id)
    assert loaded.content == {
        "assessment": {"title": "바꾼 뒤"},
        "items": [{"item_no": 1, "answers": ["가", "나"]}],
    }
    assert loaded.warnings == [
        {"code": "first", "details": {"symbols": ["가", "나"]}}
    ]


def test_assessment_can_have_only_one_rubric_draft(db_session):
    assessment = _assessment(db_session)
    db_session.add_all(
        [
            RubricDraft(assessment_id=assessment.id, content={"items": []}),
            RubricDraft(assessment_id=assessment.id, content={"items": []}),
        ]
    )

    with pytest.raises(IntegrityError):
        db_session.commit()


def test_foreign_keys_reject_orphans(db_session):
    db_session.add(
        SourceDocument(
            assessment_id=999_999,
            kind="rubric_table",
            filename="채점기준표.pdf",
            stored_path="/local/uploads/rubric.pdf",
            page_count=1,
        )
    )

    with pytest.raises(IntegrityError):
        db_session.commit()


def test_deleting_assessment_cascades_to_documents_and_rubric(db_session):
    assessment = _assessment(db_session)
    document = SourceDocument(
        assessment_id=assessment.id,
        kind="example_answer",
        filename="예시답안.pdf",
        stored_path="/local/uploads/example.pdf",
        page_count=2,
    )
    draft = RubricDraft(assessment_id=assessment.id, content={"items": []})
    db_session.add_all([document, draft])
    db_session.commit()
    document_id = document.id
    draft_id = draft.id

    db_session.delete(assessment)
    db_session.commit()
    db_session.expunge_all()

    assert db_session.get(SourceDocument, document_id) is None
    assert db_session.get(RubricDraft, draft_id) is None
