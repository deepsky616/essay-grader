from app.models.assessment import Assessment


def test_assessment_persists_and_defaults_to_draft(db_session):
    assessment = Assessment(
        title="2026 경기도교육청 초등 기본학력 평가",
        subject="수학",
        grade=6,
        total_points=20,
    )
    db_session.add(assessment)
    db_session.commit()

    loaded = db_session.get(Assessment, assessment.id)
    assert loaded.title == "2026 경기도교육청 초등 기본학력 평가"
    assert loaded.status == "draft"
    assert loaded.achievement_standards == []
    assert loaded.level_cutoffs == {}
