import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import (
    Base,
    Classroom,
    ItemResponse,
    PageImage,
    RegionSpec,
    ScanBatch,
    SheetTemplate,
    Student,
    Submission,
)
from app.models.assessment import Assessment
from app.models.document import SourceDocument


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


def _classroom(db_session) -> Classroom:
    classroom = Classroom(name="6학년 3반")
    classroom.students = [
        Student(number=1, name="김미래"),
        Student(number=2, name="박균형", absent=True),
    ]
    db_session.add(classroom)
    db_session.commit()
    return classroom


def _batch(db_session) -> tuple[ScanBatch, Classroom]:
    assessment = _assessment(db_session)
    classroom = _classroom(db_session)
    batch = ScanBatch(
        assessment_id=assessment.id,
        classroom_id=classroom.id,
        stored_path="/local/scan.pdf",
        status="pending",
    )
    db_session.add(batch)
    db_session.commit()
    return batch, classroom


def test_model_package_exports_p2_models() -> None:
    for model in (
        SheetTemplate,
        RegionSpec,
        Classroom,
        Student,
        ScanBatch,
        Submission,
        PageImage,
        ItemResponse,
    ):
        assert model.__table__.metadata is Base.metadata


def test_sheet_template_with_regions(db_session) -> None:
    assessment = _assessment(db_session)
    template = SheetTemplate(
        assessment_id=assessment.id,
        source_document_id=None,
        page_count=3,
    )
    template.regions = [
        RegionSpec(
            region_type="response",
            item_no=1,
            page_no=1,
            x=100,
            y=200,
            width=300,
            height=80,
        ),
        RegionSpec(
            region_type="pii",
            item_no=None,
            page_no=1,
            x=50,
            y=50,
            width=400,
            height=60,
        ),
    ]
    db_session.add(template)
    db_session.commit()
    db_session.expunge_all()

    loaded = db_session.scalar(select(SheetTemplate))
    assert loaded is not None
    assert len(loaded.regions) == 2
    assert {region.region_type for region in loaded.regions} == {"response", "pii"}


def test_template_is_unique_per_assessment(db_session) -> None:
    assessment = _assessment(db_session)
    db_session.add_all(
        [
            SheetTemplate(assessment_id=assessment.id, page_count=1),
            SheetTemplate(assessment_id=assessment.id, page_count=1),
        ]
    )

    with pytest.raises(IntegrityError):
        db_session.commit()


@pytest.mark.parametrize(
    "region",
    [
        RegionSpec(
            region_type="unknown", item_no=1, page_no=1,
            x=0, y=0, width=10, height=10,
        ),
        RegionSpec(
            region_type="response", item_no=None, page_no=1,
            x=0, y=0, width=10, height=10,
        ),
        RegionSpec(
            region_type="pii", item_no=1, page_no=1,
            x=0, y=0, width=10, height=10,
        ),
        RegionSpec(
            region_type="response", item_no=1, page_no=0,
            x=0, y=0, width=10, height=10,
        ),
        RegionSpec(
            region_type="response", item_no=1, page_no=1,
            x=-1, y=0, width=10, height=10,
        ),
        RegionSpec(
            region_type="response", item_no=1, page_no=1,
            x=0, y=0, width=0, height=10,
        ),
    ],
)
def test_region_database_constraints(db_session, region: RegionSpec) -> None:
    assessment = _assessment(db_session)
    template = SheetTemplate(assessment_id=assessment.id, page_count=1)
    db_session.add(template)
    db_session.commit()
    region.template_id = template.id
    db_session.add(region)

    with pytest.raises(IntegrityError):
        db_session.commit()


def test_deleting_source_document_keeps_template_and_clears_reference(db_session) -> None:
    assessment = _assessment(db_session)
    document = SourceDocument(
        assessment_id=assessment.id,
        kind="answer_sheet",
        filename="sheet.pdf",
        stored_path="/local/sheet.pdf",
        page_count=2,
    )
    db_session.add(document)
    db_session.commit()
    template = SheetTemplate(
        assessment_id=assessment.id,
        source_document_id=document.id,
        page_count=2,
    )
    db_session.add(template)
    db_session.commit()
    template_id = template.id

    db_session.delete(document)
    db_session.commit()
    db_session.expunge_all()

    loaded = db_session.get(SheetTemplate, template_id)
    assert loaded is not None
    assert loaded.source_document_id is None


def test_classroom_helpers_and_student_order(db_session) -> None:
    classroom = Classroom(name="6학년 3반")
    classroom.students = [
        Student(number=3, name="정비율"),
        Student(number=1, name="김미래"),
        Student(number=2, name="박균형", absent=True),
    ]
    db_session.add(classroom)
    db_session.commit()
    db_session.expunge_all()

    loaded = db_session.scalar(select(Classroom))
    assert loaded is not None
    assert [student.number for student in loaded.students] == [1, 2, 3]
    assert [student.name for student in loaded.present_students()] == ["김미래", "정비율"]
    assert loaded.roster_names() == ["김미래", "박균형", "정비율"]


def test_student_number_is_unique_inside_classroom(db_session) -> None:
    classroom = Classroom(name="6-3")
    classroom.students = [
        Student(number=1, name="김미래"),
        Student(number=1, name="박균형"),
    ]
    db_session.add(classroom)

    with pytest.raises(IntegrityError):
        db_session.commit()


def test_scan_graph_persists_and_cascades(db_session) -> None:
    batch, classroom = _batch(db_session)
    submission = Submission(
        batch_id=batch.id,
        student_id=classroom.students[0].id,
        page_start=0,
        page_end=3,
        anonymous_token="S-12345678",
    )
    submission.pages = [
        PageImage(
            page_no=1,
            aligned_path="/local/a.png",
            ink_path="/local/i.png",
            registration_quality=0.97,
        )
    ]
    submission.item_responses = [
        ItemResponse(item_no=1, crop_path="/local/c1.png")
    ]
    db_session.add(submission)
    db_session.commit()
    submission_id = submission.id
    page_id = submission.pages[0].id
    response_id = submission.item_responses[0].id

    assert submission.assignment_status == "pending"
    db_session.delete(batch)
    db_session.commit()
    db_session.expunge_all()

    assert db_session.get(Submission, submission_id) is None
    assert db_session.get(PageImage, page_id) is None
    assert db_session.get(ItemResponse, response_id) is None


@pytest.mark.parametrize(
    "model",
    [
        ScanBatch(
            assessment_id=1, classroom_id=1, stored_path="/x", status="unknown"
        ),
        Submission(batch_id=1, student_id=1, page_start=3, page_end=3),
        Submission(
            batch_id=1,
            student_id=1,
            page_start=0,
            page_end=1,
            assignment_status="unknown",
        ),
        PageImage(
            submission_id=1,
            page_no=0,
            aligned_path="/a",
            ink_path="/i",
            registration_quality=0.5,
        ),
        PageImage(
            submission_id=1,
            page_no=1,
            aligned_path="/a",
            ink_path="/i",
            registration_quality=1.1,
        ),
        ItemResponse(submission_id=1, item_no=0, crop_path="/c"),
    ],
)
def test_scan_database_constraints(db_session, model: object) -> None:
    db_session.add(model)

    with pytest.raises(IntegrityError):
        db_session.commit()


def test_submission_page_and_item_numbers_are_unique(db_session) -> None:
    batch, classroom = _batch(db_session)
    submission = Submission(
        batch_id=batch.id,
        student_id=classroom.students[0].id,
        page_start=0,
        page_end=2,
    )
    submission.pages = [
        PageImage(
            page_no=1,
            aligned_path="/a1",
            ink_path="/i1",
            registration_quality=1.0,
        ),
        PageImage(
            page_no=1,
            aligned_path="/a2",
            ink_path="/i2",
            registration_quality=1.0,
        ),
    ]
    db_session.add(submission)

    with pytest.raises(IntegrityError):
        db_session.commit()


def test_deleting_assessment_cascades_template_and_scan_but_not_classroom(db_session) -> None:
    assessment = _assessment(db_session)
    classroom = _classroom(db_session)
    template = SheetTemplate(assessment_id=assessment.id, page_count=1)
    batch = ScanBatch(
        assessment_id=assessment.id,
        classroom_id=classroom.id,
        stored_path="/local/scan.pdf",
    )
    db_session.add_all([template, batch])
    db_session.commit()
    template_id = template.id
    batch_id = batch.id
    classroom_id = classroom.id

    db_session.delete(assessment)
    db_session.commit()
    db_session.expunge_all()

    assert db_session.get(SheetTemplate, template_id) is None
    assert db_session.get(ScanBatch, batch_id) is None
    assert db_session.get(Classroom, classroom_id) is not None
