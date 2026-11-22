from datetime import datetime
from hashlib import sha256
from hmac import compare_digest
from threading import RLock
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.config import settings as app_config
from app.db import get_session
from app.models.app_setting import (
    DATA_POLICY_WORDING_TEXT,
    DATA_POLICY_WORDING_VERSION,
    KEY_DATA_POLICY_ACK,
    KEY_LLM_MODEL,
    KEY_LLM_MODEL_KEY_FINGERPRINT,
    AppSetting,
    DataPolicyAcknowledgement,
)
from app.providers.base import LLMProvider
from app.providers.credentials import CredentialStore, CredentialStoreError
from app.providers.gateway import TransmissionGateway
from app.providers.gemini_llm import create_gemini_provider

router = APIRouter(prefix="/api/settings", tags=["settings"])
_SETTINGS_LOCK = RLock()
_MODEL_BINDING_KEYS = (KEY_LLM_MODEL, KEY_LLM_MODEL_KEY_FINGERPRINT)


def build_provider(api_key: str, model: str | None) -> LLMProvider:
    gateway = TransmissionGateway(
        audit_log_path=app_config.audit_log_path(),
        pii_terms_provider=set,
        provider="gemini",
    )
    return create_gemini_provider(api_key=api_key, model=model, gateway=gateway)


def _list_provider_models(provider: object) -> list[str]:
    if type(provider) is not LLMProvider:
        raise TypeError("정확한 언어 모형 제공자 실행 손잡이가 필요합니다.")
    return LLMProvider.list_models(provider)


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


def _invalidate_model_binding(session: Session) -> None:
    session.execute(delete(AppSetting).where(AppSetting.key.in_(_MODEL_BINDING_KEYS)))
    session.commit()


def _key_fingerprint(api_key: str) -> str:
    digest_input = b"essay-grader:model-key:v1\0" + api_key.encode("utf-8")
    return sha256(digest_input).hexdigest()


def _write_model_binding(
    session: Session, model: str, key_fingerprint: str
) -> None:
    _upsert_setting(session, KEY_LLM_MODEL, model)
    _upsert_setting(session, KEY_LLM_MODEL_KEY_FINGERPRINT, key_fingerprint)
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


def _valid_model_for_key(session: Session, api_key: str | None) -> str | None:
    selected_model = read_setting(session, KEY_LLM_MODEL)
    bound_fingerprint = read_setting(session, KEY_LLM_MODEL_KEY_FINGERPRINT)
    current_fingerprint = _key_fingerprint(api_key) if api_key else None
    if not selected_model or not bound_fingerprint or not current_fingerprint:
        return None
    if not compare_digest(bound_fingerprint, current_fingerprint):
        return None
    return selected_model


def read_valid_llm_model(
    session: Session, store: CredentialStore
) -> str | None:
    """뒤 처리 단계에도 현재 키와 결합된 모델만 돌려준다."""
    with _SETTINGS_LOCK:
        return _valid_model_for_key(session, _api_key(store))


def read_llm_runtime(
    session: Session, store: CredentialStore
) -> tuple[str | None, str | None]:
    """같은 잠금 구간에서 현재 API 키와 그 키에 묶인 모형을 읽는다."""
    with _SETTINGS_LOCK:
        api_key = _api_key(store)
        return api_key, _valid_model_for_key(session, api_key)


def _current(session: Session, store: CredentialStore) -> SettingsOut:
    latest_policy_event = _latest_data_policy_event(session)
    api_key = _api_key(store)
    return SettingsOut(
        api_key_set=api_key is not None,
        llm_model=_valid_model_for_key(session, api_key),
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
    with _SETTINGS_LOCK:
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
    if not payload.api_key.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="API 키가 비어 있습니다.",
        )
    with _SETTINGS_LOCK:
        _invalidate_model_binding(session)
        try:
            store.set_api_key(payload.api_key)
        except CredentialStoreError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="API 키 저장소를 안전하게 사용할 수 없습니다.",
            ) from None
        return _current(session, store)


@router.delete("/api-key", response_model=SettingsOut)
def clear_api_key(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    with _SETTINGS_LOCK:
        _invalidate_model_binding(session)
        try:
            store.clear_api_key()
        except CredentialStoreError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="API 키를 안전하게 지우지 못했습니다.",
            ) from None
        return _current(session, store)


@router.get("/models")
def list_models(
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> dict[str, list[str]]:
    with _SETTINGS_LOCK:
        api_key = _api_key(store)
        if api_key is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="먼저 API 키를 입력하세요.",
            )

        provider = build_provider(api_key, read_setting(session, KEY_LLM_MODEL))
        try:
            return {"models": _list_provider_models(provider)}
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
    with _SETTINGS_LOCK:
        api_key = _api_key(store)
        if api_key is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="먼저 API 키를 입력하세요.",
            )
        fingerprint_before = _key_fingerprint(api_key)
        try:
            provider = build_provider(api_key, None)
            available_models = _list_provider_models(provider)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="모델 목록을 가져오지 못했습니다.",
            ) from None
        current_api_key = _api_key(store)
        fingerprint_after = (
            _key_fingerprint(current_api_key) if current_api_key else None
        )
        if not fingerprint_after or not compare_digest(
            fingerprint_before, fingerprint_after
        ):
            _invalidate_model_binding(session)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="API 키가 바뀌어 모델을 저장하지 않았습니다.",
            )
        if model not in available_models:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="현재 사용할 수 없는 모델입니다.",
            )
        _write_model_binding(session, model, fingerprint_after)
        return _current(session, store)


@router.put("/data-policy", response_model=SettingsOut)
def set_data_policy(
    payload: DataPolicyIn,
    session: Session = Depends(get_session),
    store: CredentialStore = Depends(get_credential_store),
) -> SettingsOut:
    with _SETTINGS_LOCK:
        _upsert_setting(
            session,
            KEY_DATA_POLICY_ACK,
            "true" if payload.acknowledged else "false",
        )
        session.add(
            DataPolicyAcknowledgement(
                wording_version=DATA_POLICY_WORDING_VERSION,
                wording_text=DATA_POLICY_WORDING_TEXT,
                acknowledged=payload.acknowledged,
            )
        )
        session.commit()
        return _current(session, store)
