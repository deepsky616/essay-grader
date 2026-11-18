import json

import pytest

from app.providers.gateway import TransmissionGateway
from app.schemas.rubric import (
    AssessmentMeta,
    Blank,
    ItemType,
    Rubric,
    RubricItem,
    RubricPart,
    ScoringRule,
)
from app.services.grading_pipeline import SubmissionContext, grade_submission
from tests.fakes import FakeRecognitionProvider, make_fake_llm_provider


def _rubric() -> Rubric:
    return Rubric(
        assessment=AssessmentMeta(
            title="시험",
            subject="수학",
            grade=6,
            total_points=6,
        ),
        items=[
            RubricItem(
                item_no=1,
                title="대칭축 찾기",
                points=2,
                type=ItemType.CLOSED_SHORT,
                blanks=[
                    Blank(key="1", answers=["선대칭"]),
                    Blank(key="2", answers=["점대칭"]),
                ],
                scoring=[
                    ScoringRule(score=2, condition="all_correct", criterion="둘 다 정확"),
                    ScoringRule(score=1, condition="partial:1", criterion="하나만"),
                    ScoringRule(score=0, condition="none_correct", criterion="모두 틀림"),
                ],
            ),
            RubricItem(
                item_no=2,
                title="점대칭 도형 그리기",
                points=2,
                type=ItemType.DRAWING,
                scoring=[
                    ScoringRule(score=2, condition="manual", criterion="정확하게 완성"),
                    ScoringRule(score=0, condition="manual", criterion="그리지 못함"),
                ],
            ),
            RubricItem(
                item_no=3,
                title="이유 서술",
                points=2,
                type=ItemType.OPEN_TEXT,
                scoring=[
                    ScoringRule(score=2, condition="llm", criterion="구체적으로 설명함"),
                    ScoringRule(score=0, condition="llm", criterion="설명하지 못함"),
                ],
            ),
        ],
    )


def _context(**overrides) -> SubmissionContext:
    defaults = dict(
        submission_id=1,
        anonymous_token="S-abcd1234",
        assignment_status="confirmed",
        registration_quality=0.97,
        crops={1: b"png1", 2: b"png2", 3: b"png3"},
    )
    defaults.update(overrides)
    return SubmissionContext(**defaults)


def _llm_ok(
    score: int,
    criterion: str,
    evidence: str = "6400원",
) -> str:
    return json.dumps(
        {
            "score": score,
            "matched_criterion": criterion,
            "evidence": evidence,
            "reasoning": "답안 근거와 기준이 맞는다",
            "confidence": 0.85,
        },
        ensure_ascii=False,
    )


def _recognizer():
    return FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"]],
        transcribe_results=["6400원이라 옳지 않다"],
    )


def test_produces_one_score_per_item():
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = grade_submission(_rubric(), _context(), _recognizer(), llm)
    assert len(scores) == 3
    assert {score.item_no for score in scores} == {1, 2, 3}


def test_open_text_grading_audit_keeps_anonymous_token(tmp_path):
    audit_path = tmp_path / "audit.log"
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")],
        gateway=TransmissionGateway(audit_path, set, "test-provider"),
    )
    grade_submission(_rubric(), _context(), _recognizer(), llm)
    entry = json.loads(audit_path.read_text(encoding="utf-8"))
    assert entry["purpose"] == "grade_open_text"
    assert entry["anonymous_token"] == "S-abcd1234"


def test_drawing_item_is_not_recognized():
    recognizer = _recognizer()
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    grade_submission(_rubric(), _context(), recognizer, llm)
    assert recognizer.calls == ["classify", "transcribe"]


def test_closed_item_is_auto_routed():
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = {
        score.item_no: score
        for score in grade_submission(_rubric(), _context(), _recognizer(), llm)
    }
    assert scores[1].route == "auto"
    assert scores[1].proposed_score == 2
    assert scores[2].route == "manual"
    assert scores[3].route == "manual"


def test_unconfirmed_assignment_forces_all_manual():
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = grade_submission(
        _rubric(),
        _context(assignment_status="needs_review"),
        _recognizer(),
        llm,
    )
    assert all(score.route == "manual" for score in scores)
    assert any("배정" in reason for reason in scores[0].routing_reasons)


def test_missing_crop_defers_item():
    recognizer = FakeRecognitionProvider()
    llm, _ = make_fake_llm_provider([])
    scores = {
        score.item_no: score
        for score in grade_submission(
            _rubric(),
            _context(crops={2: b"png2"}),
            recognizer,
            llm,
        )
    }
    assert scores[1].route == "manual"
    assert scores[1].proposed_score is None
    assert recognizer.calls == []


def test_review_all_mode_routes_everything_manual():
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = grade_submission(
        _rubric(),
        _context(),
        _recognizer(),
        llm,
        review_all=True,
    )
    assert all(score.route == "manual" for score in scores)


def test_composite_item_recognized_per_part():
    rubric = _rubric()
    rubric.items.append(
        RubricItem(
            item_no=4,
            title="계산과 수치",
            points=0,
            type=ItemType.COMPOSITE,
            parts=[
                RubricPart(part_id="calc", type=ItemType.OPEN_TEXT, points=0),
                RubricPart(
                    part_id="values",
                    type=ItemType.NUMERIC,
                    points=0,
                    numeric_answers=["25", "30"],
                ),
            ],
            scoring=[
                ScoringRule(score=0, condition="none_correct", criterion="0점"),
            ],
        )
    )
    recognizer = FakeRecognitionProvider(
        classify_results=[["선대칭", "점대칭"], ["25", "30"]],
        transcribe_results=["6400원이라 옳지 않다", "180/720×100=25"],
    )
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = {
        score.item_no: score
        for score in grade_submission(
            rubric,
            _context(crops={1: b"p1", 2: b"p2", 3: b"p3", 4: b"p4"}),
            recognizer,
            llm,
        )
    }
    assert recognizer.calls == ["classify", "transcribe", "transcribe", "classify"]
    assert scores[4].route == "manual"
    assert "25, 30" in scores[4].recognized_raw


def test_recognized_raw_is_recorded():
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = {
        score.item_no: score
        for score in grade_submission(_rubric(), _context(), _recognizer(), llm)
    }
    assert "선대칭" in scores[1].recognized_raw
    assert "6400원" in scores[3].recognized_raw


def test_missing_anonymous_token_blocks_all_external_calls():
    recognizer = _recognizer()
    llm, adapter = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = grade_submission(
        _rubric(),
        _context(anonymous_token=None),
        recognizer,
        llm,
    )
    assert all(score.route == "manual" for score in scores)
    assert recognizer.calls == []
    assert adapter.requests == []


def test_invalid_rubric_fails_before_external_calls():
    rubric = _rubric()
    rubric.items[0].blanks = []
    recognizer = _recognizer()
    llm, adapter = make_fake_llm_provider([])
    with pytest.raises(ValueError, match="루브릭"):
        grade_submission(rubric, _context(), recognizer, llm)
    assert recognizer.calls == []
    assert adapter.requests == []


def test_recognizer_exception_defers_only_affected_item():
    class BrokenRecognizer(FakeRecognitionProvider):
        def classify(self, *args, **kwargs):
            self.calls.append("classify")
            raise RuntimeError("/비밀/경로")

    recognizer = BrokenRecognizer(transcribe_results=["6400원이라 옳지 않다"])
    llm, _ = make_fake_llm_provider(
        [_llm_ok(2, "구체적으로 설명함")]
    )
    scores = {
        score.item_no: score
        for score in grade_submission(_rubric(), _context(), recognizer, llm)
    }
    assert scores[1].route == "manual"
    assert "비밀" not in scores[1].reason
    assert scores[3].proposed_score == 2
