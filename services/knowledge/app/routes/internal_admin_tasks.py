"""Internal admin task endpoints for the API proxy layer.

Authenticated with AKM_INTERNAL_SERVICE_TOKEN. The API service enforces
user-level authorization before calling these endpoints.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.services import task_store

router = APIRouter(prefix="/internal/admin/tasks", tags=["internal-admin-tasks"])


def _verify_service_token(request: Request) -> None:
    internal_token = request.app.state.settings.internal_service_token
    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {internal_token}":
        raise HTTPException(status_code=401, detail="invalid service token")


class CreateTaskBody(BaseModel):
    agent_id: str
    title: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    status: str = "backlog"
    priority: int = 3
    tags: list[str] = []
    created_by: str = ""


class UpdateTaskBody(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: int | None = None
    tags: list[str] | None = None


class TransitionBody(BaseModel):
    status: str


@router.get("")
async def list_tasks(
    request: Request,
    agent_id: str | None = Query(None),
    status: str | None = Query(None),
) -> list[dict[str, Any]]:
    _verify_service_token(request)
    pool = request.app.state.pool
    return await task_store.list_tasks(pool, agent_id=agent_id, status=status)


@router.post("")
async def create_task(body: CreateTaskBody, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    try:
        return await task_store.create_task(
            pool,
            agent_id=body.agent_id,
            title=body.title,
            description=body.description,
            status=body.status,
            priority=body.priority,
            tags=body.tags,
            created_by=body.created_by,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{task_id}")
async def get_task(task_id: str, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    task = await task_store.get_task(pool, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.put("/{task_id}")
async def update_task(
    task_id: str, body: UpdateTaskBody, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    try:
        task = await task_store.update_task(
            pool, task_id, **body.model_dump(exclude_none=True)
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.patch("/{task_id}/transition")
async def transition_task(
    task_id: str, body: TransitionBody, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    try:
        task = await task_store.transition_task(pool, task_id, body.status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.delete("/{task_id}")
async def cancel_task(task_id: str, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool
    task = await task_store.transition_task(pool, task_id, "cancelled")
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task
