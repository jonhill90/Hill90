"""Agent-facing shared knowledge endpoints.

Authenticated via Ed25519 JWT (same middleware as AKM entries).
Uses `owner` claim from JWT for visibility scoping.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.services import shared_store
from app.services.quality import compute_quality_summary, enrich_results_with_quality

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

    if collection_id is not None:
        try:
            __import__("uuid").UUID(collection_id)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=422, detail=f"invalid collection_id: {collection_id}")

    # Owner from JWT claim (added at signing time)
    owner = claims.owner
    if owner is None:
        raise HTTPException(
            status_code=403,
            detail="agent JWT missing owner claim — cannot determine visibility scope",
        )

    # Try hybrid search (FTS + vector) if embeddings are available
    from app.services.embeddings import generate_embedding

    t0 = time.monotonic()
    query_embedding = await generate_embedding(q)

    if query_embedding:
        results = await shared_store.hybrid_search_chunks(
            pool,
            q,
            query_embedding,
            owner=owner,
            collection_id=collection_id,
            limit=limit,
        )
        search_type = "hybrid"
    else:
        results = await shared_store.search_chunks(
            pool,
            q,
            owner=owner,
            collection_id=collection_id,
            limit=limit,
        )
        search_type = "fts"
    duration_ms = int((time.monotonic() - t0) * 1000)

    results = enrich_results_with_quality(results)
    quality_summary = compute_quality_summary(results)

    # Record audit
    chunk_ids = [r["chunk_id"] for r in results]
    resolved_collection_id = collection_id
    if resolved_collection_id is None and results:
        resolved_collection_id = results[0].get("collection_id")

    await shared_store.record_retrieval(
        pool,
        query=q,
        requester_type="agent",
        requester_id=claims.sub,
        agent_owner=owner,
        result_count=len(results),
        chunk_ids=chunk_ids,
        duration_ms=duration_ms,
        collection_id=resolved_collection_id,
    )

    return {
        "query": q,
        "results": results,
        "count": len(results),
        "search_type": search_type,
        "score_type": "hybrid" if search_type == "hybrid" else "ts_rank",
        "quality_summary": quality_summary,
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
