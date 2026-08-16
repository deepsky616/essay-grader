from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.db import get_session
from app.models.job import Job


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: str
    status: Literal["pending", "running", "succeeded", "failed"]
    result: dict[str, Any] | None
    error: str | None
    progress_done: int
    progress_total: int
    progress_message: str


@router.get("/{job_id}", response_model=JobOut)
def get_job(
    job_id: int,
    session: Session = Depends(get_session),
) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="작업을 찾을 수 없습니다.",
        )
    return job
