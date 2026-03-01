"""Agent-facing shared knowledge endpoints.

Authenticated via Ed25519 JWT (same middleware as AKM entries).
Uses `owner` claim from JWT for visibility scoping.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.services import shared_store

router = APIRouter(prefix="/api/v1/shared", tags=["shared-knowledge"])


def _get_claims(request: Request) -> Any:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return claims


@router.get("/search")
async def search_shared(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query"),
    collection_id: str | None = Query(None, description="Optional collection filter"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
) -> dict[str, Any]:
    """Search shared knowledge. Scoped to agent owner's private + all shared collections."""
    claims = _get_claims(request)
    pool = request.app.state.pool

    # Owner from JWT claim (added at signing time)
    owner = claims.owner
    if owner is None:
        raise HTTPException(
            status_code=403,
            detail="agent JWT missing owner claim — cannot determine visibility scope",
        )

    results = await shared_store.search_chunks(
        pool,
        q,
        owner=owner,
        collection_id=collection_id,
        limit=limit,
    )

    # Record audit
    chunk_ids = [r["chunk_id"] for r in results]
    await shared_store.record_retrieval(
        pool,
        query=q,
        requester_type="agent",
        requester_id=claims.sub,
        agent_owner=owner,
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


@router.get("/collections")
async def list_collections(request: Request) -> list[dict[str, Any]]:
    """List shared knowledge collections visible to the agent's owner."""
    claims = _get_claims(request)
    pool = request.app.state.pool

    owner = claims.owner
    if owner is None:
        raise HTTPException(
            status_code=403,
            detail="agent JWT missing owner claim",
        )

    return await shared_store.list_collections(pool, owner=owner)
