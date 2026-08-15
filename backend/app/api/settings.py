from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings as app_config
from app.db import get_session
from app.models.app_setting import KEY_DATA_POLICY_ACK, KEY_LLM_MODEL, AppSetting
from app.providers.base import LLMProvider
from app.providers.credentials import CredentialStore
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import GeminiLLMProvider

router = APIRouter(prefix="/api/settings", tags=["settings"])


def build_provider(api_key: str, model: str | None) -> LLMProvider:
    gateway = TransmissionGateway(
        audit_log_path=app_config.audit_log_path(),
        pii_terms_provider=set,
        provider="gemini",
    )
    return GeminiLLMProvider(api_key=api_key, model=model, gateway=gateway)


def get_credential_store() -> CredentialStore:
    return CredentialStore(fallback_path=app_config.data_dir / "gemini-api-key")


class ApiKeyIn(BaseModel):
    api_key: Any


class ModelIn(BaseModel):
    llm_model: str


class DataPolicyIn(BaseModel):
    acknowledged: bool


class SettingsOut(BaseModel):
    api_key_set: bool
    llm_model: str | None
    data_policy_acknowledged: bool


def read_setting(session: Session, key: str) -> str | None:
    row = session.scalar(select(AppSetting).where(AppSetting.key == key))
    return row.value if row else None


def write_setting(session: Session, key: str, value: str) -> None:
    row = session.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None:
        session.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    session.commit()


def _current(session: Session, store: CredentialStore) -> SettingsOut:
    return SettingsOut(
        api_key_set=store.get_api_key() is not None,
        llm_model=read_setting(session, KEY_LLM_MODEL),
        data_policy_acknowledged=read_setting(session, KEY_DATA_POLICY_ACK) == "true",
    )


@router.get("", response_model=SettingsOut)
def get_settings(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    return _current(session, store)


@router.put("/api-key", response_model=SettingsOut)
def set_api_key(
    payload: ApiKeyIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    if not isinstance(payload.api_key, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="API 키 형식이 올바르지 않습니다.",
        )
    try:
        store.set_api_key(payload.api_key)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="API 키가 비어 있습니다.",
        ) from error
    return _current(session, store)


@router.delete("/api-key", response_model=SettingsOut)
def clear_api_key(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    store.clear_api_key()
    return _current(session, store)


@router.get("/models")
def list_models(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> dict[str, list[str]]:
    api_key = store.get_api_key()
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="먼저 API 키를 입력하세요.",
        )

    provider = build_provider(api_key, read_setting(session, KEY_LLM_MODEL))
    try:
        return {"models": provider.list_models()}
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="모델 목록을 가져오지 못했습니다.",
        ) from error


@router.put("/model", response_model=SettingsOut)
def set_model(
    payload: ModelIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    model = payload.llm_model.strip()
    if not model:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="모델 이름이 비어 있습니다.",
        )
    write_setting(session, KEY_LLM_MODEL, model)
    return _current(session, store)


@router.put("/data-policy", response_model=SettingsOut)
def set_data_policy(
    payload: DataPolicyIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    write_setting(
        session,
        KEY_DATA_POLICY_ACK,
        "true" if payload.acknowledged else "false",
    )
    return _current(session, store)
