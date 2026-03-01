"""Internal admin endpoints for shared knowledge — API proxy layer.

Authenticated with AKM_INTERNAL_SERVICE_TOKEN. The API service enforces
user-level authorization before calling these endpoints.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.services import shared_store
from app.services.ingest import IngestError, ingest_source


def _validate_uuid(value: str, label: str = "id") -> None:
    """Raise 422 if value is not a valid UUID."""
    try:
        __import__("uuid").UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"invalid {label}: {value}")

router = APIRouter(prefix="/internal/admin/shared", tags=["internal-admin-shared"])


def _verify_service_token(request: Request) -> None:
    internal_token = request.app.state.settings.internal_service_token
    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {internal_token}":
        raise HTTPException(status_code=401, detail="invalid service token")


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------


class CollectionCreate(BaseModel):
    name: str
    description: str = ""
    visibility: str = "private"
    created_by: str


class CollectionUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    visibility: str | None = None


@router.post("/collections")
async def create_collection(
    body: CollectionCreate, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool

    if body.visibility not in ("private", "shared"):
        raise HTTPException(status_code=422, detail="visibility must be 'private' or 'shared'")

    try:
        return await shared_store.create_collection(
            pool,
            name=body.name,
            description=body.description,
            visibility=body.visibility,
            created_by=body.created_by,
        )
    except Exception as exc:
        if "unique" in str(exc).lower():
            raise HTTPException(
                status_code=409,
                detail=f"collection '{body.name}' already exists for this user",
            )
        raise


@router.get("/collections")
async def list_collections(
    request: Request,
    owner: str | None = Query(None, description="Owner user sub for scoping"),
) -> list[dict[str, Any]]:
    _verify_service_token(request)
    pool = request.app.state.pool
    return await shared_store.list_collections(pool, owner=owner)


@router.get("/collections/{collection_id}")
async def get_collection(
    collection_id: str, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool
    result = await shared_store.get_collection(pool, collection_id)
    if result is None:
        raise HTTPException(status_code=404, detail="collection not found")
    return result


@router.put("/collections/{collection_id}")
async def update_collection(
    collection_id: str, body: CollectionUpdate, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool

    if body.visibility is not None and body.visibility not in ("private", "shared"):
        raise HTTPException(status_code=422, detail="visibility must be 'private' or 'shared'")

    result = await shared_store.update_collection(
        pool,
        collection_id,
        name=body.name,
        description=body.description,
        visibility=body.visibility,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="collection not found")
    return result


@router.delete("/collections/{collection_id}")
async def delete_collection(
    collection_id: str, request: Request
) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(collection_id, "collection_id")
    pool = request.app.state.pool
    deleted = await shared_store.delete_collection(pool, collection_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="collection not found")
    return {"deleted": True, "id": collection_id}


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


class SourceCreate(BaseModel):
    collection_id: str
    title: str
    source_type: str
    raw_content: str | None = None
    source_url: str | None = None
    created_by: str


@router.post("/sources")
async def create_source(body: SourceCreate, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(body.collection_id, "collection_id")
    pool = request.app.state.pool

    try:
        result = await ingest_source(
            pool,
            collection_id=body.collection_id,
            title=body.title,
            source_type=body.source_type,
            raw_content=body.raw_content or "",
            source_url=body.source_url,
            created_by=body.created_by,
        )
    except IngestError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # ingest_source returns error payload on internal failure (after job creation)
    if result.get("source", {}).get("status") == "error":
        raise HTTPException(
            status_code=500,
            detail=result.get("ingest_job", {}).get("error_message", "ingest failed"),
        )

    return result


@router.get("/sources")
async def list_sources(
    request: Request,
    collection_id: str = Query(..., description="Collection to list sources from"),
) -> list[dict[str, Any]]:
    _verify_service_token(request)
    pool = request.app.state.pool
    return await shared_store.list_sources(pool, collection_id)


@router.get("/sources/{source_id}")
async def get_source(source_id: str, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(source_id, "source_id")
    pool = request.app.state.pool
    result = await shared_store.get_source(pool, source_id)
    if result is None:
        raise HTTPException(status_code=404, detail="source not found")
    return result


@router.delete("/sources/{source_id}")
async def delete_source(source_id: str, request: Request) -> dict[str, Any]:
    _verify_service_token(request)
    _validate_uuid(source_id, "source_id")
    pool = request.app.state.pool
    deleted = await shared_store.delete_source(pool, source_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="source not found")
    return {"deleted": True, "id": source_id}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@router.get("/search")
async def search_shared(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query"),
    collection_id: str | None = Query(None, description="Optional collection filter"),
    owner: str | None = Query(None, description="Owner sub for visibility scoping"),
    requester_id: str = Query(..., description="Requester ID for audit"),
    requester_type: str = Query("user", description="Requester type: user or agent"),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    _verify_service_token(request)
    pool = request.app.state.pool

    if requester_type not in ("user", "agent"):
        raise HTTPException(status_code=422, detail="requester_type must be 'user' or 'agent'")

    results = await shared_store.search_chunks(
        pool,
        q,
        owner=owner,
        collection_id=collection_id,
        limit=limit,
    )

    chunk_ids = [r["chunk_id"] for r in results]
    await shared_store.record_retrieval(
        pool,
        query=q,
        requester_type=requester_type,
        requester_id=requester_id,
        result_count=len(results),
        chunk_ids=chunk_ids,
    )

    return {
        "query": q,
        "results": results,
        "count": len(results),
        "search_type": "fts",
        "score_type": "ts_rank",
    }
