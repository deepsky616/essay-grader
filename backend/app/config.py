from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    data_dir: Path = Path.home() / "essay-grader-data"
    db_path: Path | None = None

    # 모델 이름은 하드코딩하지 않는다. 교사가 설정 화면에서 목록을 조회해 고른 값을
    # DB(AppSetting)에 저장하고, 아래 값은 최초 조회 실패 시의 대비책일 뿐이다.
    fallback_llm_model: str = "gemini-2.5-pro"

    model_config = {"env_prefix": "EG_"}

    def resolved_db_path(self) -> Path:
        return self.db_path or (self.data_dir / "essay-grader.db")

    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    def audit_log_path(self) -> Path:
        return self.data_dir / "audit.log"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.uploads_dir().mkdir(parents=True, exist_ok=True)


settings = Settings()
