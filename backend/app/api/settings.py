from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.config import settings as app_config
from app.db import get_session
from app.models.app_setting import (
    DATA_POLICY_WORDING_VERSION,
    KEY_DATA_POLICY_ACK,
    KEY_LLM_MODEL,
    AppSetting,
    DataPolicyAcknowledgement,
)
from app.providers.base import LLMProvider
from app.providers.credentials import CredentialStore, CredentialStoreError
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
    configured_key = app_config.credential_encryption_key
    encryption_key = configured_key.get_secret_value() if configured_key else None
    return CredentialStore(
        fallback_path=app_config.data_dir / "gemini-api-key",
        fallback_encryption_key=encryption_key,
    )


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
    data_policy_acknowledged_at: datetime | None


def read_setting(session: Session, key: str) -> str | None:
    row = session.scalar(select(AppSetting).where(AppSetting.key == key))
    return row.value if row else None


def write_setting(session: Session, key: str, value: str) -> None:
    _upsert_setting(session, key, value)
    session.commit()


def _upsert_setting(session: Session, key: str, value: str) -> None:
    statement = sqlite_insert(AppSetting).values(key=key, value=value)
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[AppSetting.key],
            set_={"value": statement.excluded.value, "updated_at": func.now()},
        )
    )


def delete_setting(session: Session, key: str) -> None:
    session.execute(delete(AppSetting).where(AppSetting.key == key))
    session.commit()


def _api_key(store: CredentialStore) -> str | None:
    try:
        return store.get_api_key()
    except CredentialStoreError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API 키 저장소를 안전하게 사용할 수 없습니다.",
        ) from None


def _latest_data_policy_event(
    session: Session,
) -> DataPolicyAcknowledgement | None:
    return session.scalar(
        select(DataPolicyAcknowledgement)
        .order_by(DataPolicyAcknowledgement.id.desc())
        .limit(1)
    )


def _current(session: Session, store: CredentialStore) -> SettingsOut:
    latest_policy_event = _latest_data_policy_event(session)
    return SettingsOut(
        api_key_set=_api_key(store) is not None,
        llm_model=read_setting(session, KEY_LLM_MODEL),
        data_policy_acknowledged=read_setting(session, KEY_DATA_POLICY_ACK) == "true",
        data_policy_acknowledged_at=(
            latest_policy_event.confirmed_at if latest_policy_event else None
        ),
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
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="API 키가 비어 있습니다.",
        ) from None
    except CredentialStoreError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API 키 저장소를 안전하게 사용할 수 없습니다.",
        ) from None
    delete_setting(session, KEY_LLM_MODEL)
    return _current(session, store)


@router.delete("/api-key", response_model=SettingsOut)
def clear_api_key(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    try:
        store.clear_api_key()
    except CredentialStoreError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API 키를 안전하게 지우지 못했습니다.",
        ) from None
    delete_setting(session, KEY_LLM_MODEL)
    return _current(session, store)


@router.get("/models")
def list_models(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> dict[str, list[str]]:
    api_key = _api_key(store)
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="먼저 API 키를 입력하세요.",
        )

    provider = build_provider(api_key, read_setting(session, KEY_LLM_MODEL))
    try:
        return {"models": provider.list_models()}
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="모델 목록을 가져오지 못했습니다.",
        ) from None


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
    api_key = _api_key(store)
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="먼저 API 키를 입력하세요.",
        )
    try:
        available_models = build_provider(api_key, None).list_models()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="모델 목록을 가져오지 못했습니다.",
        ) from None
    if model not in available_models:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="현재 사용할 수 없는 모델입니다.",
        )
    write_setting(session, KEY_LLM_MODEL, model)
    return _current(session, store)


@router.put("/data-policy", response_model=SettingsOut)
def set_data_policy(
    payload: DataPolicyIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    _upsert_setting(
        session, KEY_DATA_POLICY_ACK, "true" if payload.acknowledged else "false"
    )
    session.add(
        DataPolicyAcknowledgement(
            wording_version=DATA_POLICY_WORDING_VERSION,
            acknowledged=payload.acknowledged,
        )
    )
    session.commit()
    return _current(session, store)
