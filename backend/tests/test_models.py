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


def test_in_place_rubric_changes_persist_without_leaking_to_other_assessments(
    db_session,
):
    changed = Assessment(
        title="첫 평가",
        subject="수학",
        grade=6,
        total_points=20,
    )
    untouched = Assessment(
        title="둘째 평가",
        subject="수학",
        grade=6,
        total_points=20,
    )
    db_session.add_all([changed, untouched])
    db_session.commit()

    changed.achievement_standards.append({"id": "AS1"})
    changed.level_cutoffs["3"] = 17
    db_session.commit()
    db_session.expunge_all()

    reloaded_changed = db_session.get(Assessment, changed.id)
    reloaded_untouched = db_session.get(Assessment, untouched.id)
    assert reloaded_changed.achievement_standards == [{"id": "AS1"}]
    assert reloaded_changed.level_cutoffs == {"3": 17}
    assert reloaded_untouched.achievement_standards == []
    assert reloaded_untouched.level_cutoffs == {}
