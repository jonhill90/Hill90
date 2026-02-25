"""CRUD routes for knowledge entries."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.middleware.agent_auth import AgentClaims
from app.services import knowledge_store

router = APIRouter(prefix="/api/v1/entries", tags=["entries"])


class CreateEntryRequest(BaseModel):
    path: str
    content: str


class UpdateEntryRequest(BaseModel):
    content: str


def _get_claims(request: Request) -> AgentClaims:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return claims


def _get_pool(request: Request):  # type: ignore[no-untyped-def]
    return request.app.state.pool


def _get_data_dir(request: Request) -> str:
    return request.app.state.settings.data_dir


@router.post("", status_code=201)
async def create_entry(body: CreateEntryRequest, request: Request) -> dict:
    claims = _get_claims(request)
    pool = _get_pool(request)
    data_dir = _get_data_dir(request)

    try:
        entry = await knowledge_store.create_entry(pool, data_dir, claims, body.path, body.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _serialize_entry(entry)


@router.get("/{path:path}")
async def read_entry(path: str, request: Request) -> dict:
    claims = _get_claims(request)
    pool = _get_pool(request)

    # Return 404 for both missing and cross-agent entries to avoid information leakage
    entry = await knowledge_store.read_entry(pool, claims, path)
    if entry is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return _serialize_entry(entry)


@router.put("/{path:path}")
async def update_entry(path: str, body: UpdateEntryRequest, request: Request) -> dict:
    claims = _get_claims(request)
    pool = _get_pool(request)
    data_dir = _get_data_dir(request)

    try:
        entry = await knowledge_store.update_entry(pool, data_dir, claims, path, body.content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if entry is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return _serialize_entry(entry)


@router.delete("/{path:path}")
async def archive_entry(path: str, request: Request) -> dict:
    claims = _get_claims(request)
    pool = _get_pool(request)

    try:
        result = await knowledge_store.archive_entry(pool, claims, path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if result is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return result


def _serialize_entry(entry: dict) -> dict:
    """Serialize entry for JSON response, converting UUIDs and datetimes."""
    result = {}
    for key, value in entry.items():
        if hasattr(value, "hex"):  # UUID
            result[key] = str(value)
        elif hasattr(value, "isoformat"):  # datetime
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result
