from dataclasses import replace

from app.services.feedback_generator import GeneratedFeedback
from app.services.feedback_render import render_all, render_one
from tests.test_feedback_generator import _context


def _generated(**overrides) -> GeneratedFeedback:
    values = {
        "item_comments": [
            {
                "item_no": 1,
                "score": 2,
                "max": 2,
                "comment": "학생은 뜻을 정확히 알아요.",
            },
            {
                "item_no": 2,
                "score": 1,
                "max": 2,
                "comment": "대응점을 더 찾아 보세요.",
            },
        ],
        "summary": "학생은 대칭의 뜻을 잘 이해하고 있어요.",
        "next_step": "모눈종이에 더 그려 보세요.",
    }
    values.update(overrides)
    return GeneratedFeedback(**values)


def test_real_name_is_inserted_locally():
    html = render_one(_context(), _generated())
    assert "김미래 학생은 뜻을 정확히 알아요." in html
    assert "김미래 학생은 대칭의 뜻을 잘 이해하고 있어요." in html


def test_summary_without_anonymous_subject_gets_local_subject():
    html = render_one(
        _context(),
        _generated(summary="대칭의 뜻을 잘 이해하고 있어요."),
    )
    assert "김미래 학생은 대칭의 뜻을 잘 이해하고 있어요." in html


def test_scores_and_level_appear_in_output():
    html = render_one(_context(), _generated())
    assert "4점 만점에 3점" in html
    assert "2수준" in html


def test_html_escapes_generated_and_local_content():
    context = replace(_context(), student_name="<img src=x onerror=alert(1)>")
    generated = _generated(summary="<script>alert(1)</script>")
    html = render_one(context, generated)

    assert "<script>" not in html
    assert "<img src=x" not in html
    assert "&lt;script&gt;" in html
    assert "&lt;img" in html


def test_render_all_includes_every_student_and_page_break():
    first = _context()
    second = replace(_context(), student_name="박균형", student_number=2)

    html = render_all([(first, _generated()), (second, _generated())])
    assert "김미래" in html
    assert "박균형" in html
    assert "page-break-before" in html


def test_degraded_feedback_warning_is_surfaced():
    html = render_one(_context(), _generated(degraded=True))
    assert "대체 문장" in html


def test_document_has_restrictive_content_policy_and_no_remote_assets():
    html = render_all([(_context(), _generated())])
    assert "default-src 'none'" in html
    assert "http://" not in html
    assert "https://" not in html
