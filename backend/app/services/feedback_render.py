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


def render_one(
    context: FeedbackContext,
    generated: GeneratedFeedback,
) -> str:
    template = _environment.get_template("feedback.html.j2")
    return template.render(context=context, generated=generated)


def render_all(
    pairs: list[tuple[FeedbackContext, GeneratedFeedback]],
    title: str = "평가 피드백",
) -> str:
    blocks = [render_one(context, generated) for context, generated in pairs]
    template = _environment.get_template("feedback_all.html.j2")
    return template.render(title=title, blocks=blocks)
