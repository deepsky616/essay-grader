from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    data_dir: Path = Path.home() / "essay-grader-data"
    db_path: Path | None = None
    credential_encryption_key: SecretStr | None = None

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
