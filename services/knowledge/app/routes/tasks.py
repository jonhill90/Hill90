"""Agent-facing task endpoints (Ed25519 JWT auth)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.services import task_store

router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


class CreateTaskRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    status: str = "backlog"
    priority: int = 3
    tags: list[str] = []


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: int | None = None
    tags: list[str] | None = None


class TransitionRequest(BaseModel):
    status: str


@router.post("")
async def create_task(body: CreateTaskRequest, request: Request) -> dict[str, Any]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    try:
        task = await task_store.create_task(
            pool,
            agent_id=claims.sub,
            title=body.title,
            description=body.description,
            status=body.status,
            priority=body.priority,
            tags=body.tags,
            created_by=claims.sub,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return task


@router.get("")
async def list_tasks(
    request: Request,
    status: str | None = Query(None),
) -> list[dict[str, Any]]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    return await task_store.list_tasks(pool, agent_id=claims.sub, status=status)


@router.get("/{task_id}")
async def get_task(task_id: str, request: Request) -> dict[str, Any]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    task = await task_store.get_task(pool, task_id)
    if task is None or task["agent_id"] != claims.sub:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.put("/{task_id}")
async def update_task(
    task_id: str, body: UpdateTaskRequest, request: Request
) -> dict[str, Any]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    existing = await task_store.get_task(pool, task_id)
    if existing is None or existing["agent_id"] != claims.sub:
        raise HTTPException(status_code=404, detail="task not found")

    try:
        task = await task_store.update_task(
            pool,
            task_id,
            **body.model_dump(exclude_none=True),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.patch("/{task_id}/transition")
async def transition_task(
    task_id: str, body: TransitionRequest, request: Request
) -> dict[str, Any]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    existing = await task_store.get_task(pool, task_id)
    if existing is None or existing["agent_id"] != claims.sub:
        raise HTTPException(status_code=404, detail="task not found")

    try:
        task = await task_store.transition_task(pool, task_id, body.status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task
