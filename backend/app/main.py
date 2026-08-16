from fastapi import FastAPI

from app.api import assessments, documents, rubrics
from app.api import settings as settings_api
from app.config import settings


def create_app() -> FastAPI:
    settings.ensure_dirs()
    app = FastAPI(title="논술형 자동채점")
    app.include_router(settings_api.router)
    app.include_router(assessments.router)
    app.include_router(documents.router)
    app.include_router(rubrics.router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
