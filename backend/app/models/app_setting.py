from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class AppSetting(Base, TimestampMixin):
    """비밀값을 제외한 전역 설정을 키와 값으로 보관한다."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


KEY_LLM_MODEL = "llm_model"
KEY_DATA_POLICY_ACK = "data_policy_acknowledged"
