import json

from app.providers.gateway import TransmissionGateway
from app.services.feedback_builder import FeedbackContext, ItemDetail
from app.services.feedback_generator import generate_feedback
from tests.fakes import make_fake_llm_provider


def _context(total=3) -> FeedbackContext:
    return FeedbackContext(
        submission_id=1,
        student_number=1,
        student_name="김미래",
        anonymous_token="S-abcd1234",
        grade=6,
        subject="수학",
        total_score=total,
        total_points=4,
        level="2",
        level_description="조건에 맞게 간단한 대칭인 도형을 그릴 수 있다.",
        level_warning=None,
        items=[
            ItemDetail(
                item_no=1,
                title="대칭축 찾기",
                score=2,
                max_points=2,
                criterion="둘 다 정확",
                example_answer="1 선대칭 2 점대칭",
                standard_id="AS1",
            ),
            ItemDetail(
                item_no=2,
                title="점대칭 도형 그리기",
                score=1,
                max_points=2,
                criterion="일부만 완성",
                example_answer="예시 그림 참조",
                standard_id="AS1",
            ),
        ],
        standards=[],
    )


def _llm_output(**overrides) -> str:
    payload = {
        "item_comments": [
            {"item_no": 1, "comment": "선대칭과 점대칭의 뜻을 정확히 알고 있어요."},
            {"item_no": 2, "comment": "대응점을 몇 개 더 찾으면 도형을 완성할 수 있어요."},
        ],
        "summary": "학생은 대칭의 뜻을 잘 이해하고 있어요.",
        "next_step": "모눈종이에 점대칭 도형을 두세 개 더 그려 보세요.",
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def test_generates_comment_for_each_item():
    provider, _adapter = make_fake_llm_provider([_llm_output()])
    result = generate_feedback(_context(), provider)

    assert len(result.item_comments) == 2
    assert result.item_comments[0]["item_no"] == 1
    assert result.summary
    assert result.next_step
    assert result.degraded is False


def test_prompt_contains_no_real_name():
    provider, adapter = make_fake_llm_provider([_llm_output()])
    generate_feedback(_context(), provider, pii_terms={"김미래"})

    prompt = adapter.requests[0].user_text
    assert "김미래" not in prompt
    assert "S-abcd1234" in prompt


def test_feedback_audit_keeps_anonymous_token(tmp_path):
    audit_path = tmp_path / "audit.log"
    gateway = TransmissionGateway(
        audit_log_path=audit_path,
        pii_terms_provider=set,
        provider="test-provider",
    )
    provider, _adapter = make_fake_llm_provider([_llm_output()], gateway=gateway)

    generate_feedback(_context(), provider)

    entry = json.loads(audit_path.read_text())
    assert entry["purpose"] == "generate_feedback"
    assert entry["anonymous_token"] == "S-abcd1234"


def test_prompt_states_grade_for_tone():
    provider, adapter = make_fake_llm_provider([_llm_output()])
    generate_feedback(_context(), provider)

    request = adapter.requests[0]
    assert "6학년" in request.system or "6학년" in request.user_text


def test_missing_comment_gets_criterion_fallback_and_marks_degraded():
    provider, _adapter = make_fake_llm_provider(
        [_llm_output(item_comments=[{"item_no": 1, "comment": "잘했어요."}])]
    )
    result = generate_feedback(_context(), provider)

    assert len(result.item_comments) == 2
    assert result.item_comments[1]["comment"] == "일부만 완성"
    assert result.degraded is True


def test_unknown_or_duplicate_items_fall_back():
    provider, _adapter = make_fake_llm_provider(
        [
            _llm_output(
                item_comments=[
                    {"item_no": 99, "comment": "없는 문항"},
                    {"item_no": 99, "comment": "중복"},
                ]
            )
        ]
    )
    result = generate_feedback(_context(), provider)

    assert result.degraded is True
    assert [row["comment"] for row in result.item_comments] == [
        "둘 다 정확",
        "일부만 완성",
    ]


def test_malformed_or_wrapped_json_falls_back():
    for raw in ["JSON 이 아닙니다", f"```json\n{_llm_output()}\n```"]:
        provider, _adapter = make_fake_llm_provider([raw])
        result = generate_feedback(_context(), provider)
        assert result.degraded is True
        assert len(result.item_comments) == 2


def test_extra_output_keys_fall_back():
    provider, _adapter = make_fake_llm_provider([_llm_output(extra="no")])
    assert generate_feedback(_context(), provider).degraded is True


def test_llm_failure_falls_back_without_error_text():
    provider, _adapter = make_fake_llm_provider([RuntimeError("secret network error")])
    result = generate_feedback(_context(), provider)

    assert result.degraded is True
    assert "secret" not in str(result)


def test_scores_are_included_in_comments():
    provider, _adapter = make_fake_llm_provider([_llm_output()])
    result = generate_feedback(_context(), provider)

    assert result.item_comments[0]["score"] == 2
    assert result.item_comments[0]["max"] == 2


def test_real_name_in_response_is_masked():
    provider, _adapter = make_fake_llm_provider(
        [_llm_output(summary="김미래 학생은 잘 이해하고 있어요.")]
    )
    result = generate_feedback(_context(), provider, pii_terms={"김미래"})

    assert "김미래" not in result.summary
    assert "학생" in result.summary


def test_oversized_comment_falls_back():
    provider, _adapter = make_fake_llm_provider(
        [
            _llm_output(
                item_comments=[
                    {"item_no": 1, "comment": "가" * 4001},
                    {"item_no": 2, "comment": "좋아요"},
                ]
            )
        ]
    )

    assert generate_feedback(_context(), provider).degraded is True
