from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AppSetting(Base, TimestampMixin):
    """비밀값을 제외한 전역 설정을 키와 값으로 보관한다."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class DataPolicyAcknowledgement(Base):
    """자료 정책 확인을 덮어쓰지 않고 남기는 사건 기록."""

    __tablename__ = "data_policy_acknowledgements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    wording_version: Mapped[str] = mapped_column(String(80), nullable=False)
    wording_text: Mapped[str] = mapped_column(Text, nullable=False)
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False)
    confirmed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


KEY_LLM_MODEL = "llm_model"
KEY_LLM_MODEL_KEY_FINGERPRINT = "llm_model_key_fingerprint"
KEY_DATA_POLICY_ACK = "data_policy_acknowledged"
DATA_POLICY_WORDING_VERSION = "paid-tier-no-training-v1"
DATA_POLICY_WORDING_TEXT = (
    "유료 등급 키를 사용 중이며 제출 내용이 모델 학습에 사용되지 않음을 확인했다"
)
