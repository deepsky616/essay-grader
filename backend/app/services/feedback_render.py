"""지역 템플릿에서만 실명을 넣어 인쇄용 문서를 만든다."""

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from app.services.feedback_builder import FeedbackContext
from app.services.feedback_generator import GeneratedFeedback


TEMPLATE_DIR = Path(__file__).parent.parent / "templates"

_environment = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    autoescape=select_autoescape(["html", "j2"]),
    undefined=StrictUndefined,
    auto_reload=False,
)


def personalize(
    text: str,
    student_name: str,
    add_subject: bool = False,
) -> str:
    """익명 주어를 지역 학생 이름으로 바꾼다."""
    if text.startswith("학생"):
        return f"{student_name} 학생{text[2:]}"
    if add_subject:
        return f"{student_name} 학생은 {text}"
    return text


def render_one(
    context: FeedbackContext,
    generated: GeneratedFeedback,
) -> str:
    template = _environment.get_template("feedback.html.j2")
    return template.render(
        context=context,
        generated=generated,
        personalize=personalize,
    )


def render_all(
    pairs: list[tuple[FeedbackContext, GeneratedFeedback]],
    title: str = "평가 피드백",
) -> str:
    blocks = [render_one(context, generated) for context, generated in pairs]
    template = _environment.get_template("feedback_all.html.j2")
    return template.render(title=title, blocks=blocks)
