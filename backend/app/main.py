from pathlib import Path

from fastapi import FastAPI

from app.api import assessments, documents, jobs, rubrics
from app.api import settings as settings_api
from app.config import settings
from app.spa_static import SPAStaticFiles


def create_app(static_dir: Path | None = None) -> FastAPI:
    settings.ensure_dirs()
    app = FastAPI(title="논술형 자동채점")
    app.include_router(settings_api.router)
    app.include_router(assessments.router)
    app.include_router(documents.router)
    app.include_router(rubrics.router)
    app.include_router(jobs.router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    selected_static_dir = static_dir or (Path(__file__).parent / "static")
    if (
        selected_static_dir.is_dir()
        and not selected_static_dir.is_symlink()
    ):
        app.mount(
            "/",
            SPAStaticFiles(directory=selected_static_dir, html=True),
            name="static",
        )

    return app


app = create_app()
