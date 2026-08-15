from fastapi import FastAPI

from app.config import settings


def create_app() -> FastAPI:
    settings.ensure_dirs()
    app = FastAPI(title="논술형 자동채점")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
