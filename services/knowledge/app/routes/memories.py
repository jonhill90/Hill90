"""Agent persistent memory endpoints.

Authenticated via Ed25519 JWT (same middleware as AKM entries).
Agent ID comes from JWT `sub` claim.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.services import memory_store
from app.services.embeddings import generate_embedding

router = APIRouter(prefix="/api/v1/memories", tags=["agent-memories"])


def _get_claims(request: Request) -> Any:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return claims


class SaveMemoryRequest(BaseModel):
    content: str


@router.post("")
async def save_memory(request: Request, body: SaveMemoryRequest) -> dict[str, Any]:
    """Save a memory for the authenticated agent."""
    claims = _get_claims(request)
    pool = request.app.state.pool
    agent_id = claims.sub

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")
    if len(content) > 2000:
        raise HTTPException(status_code=400, detail="memory too long (max 2000 chars)")

    # Generate embedding
    try:
        embedding = await generate_embedding(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate embedding: {e}")

    result = await memory_store.save_memory(pool, agent_id, content, embedding)
    return {"saved": True, "memory": result}


@router.get("/recall")
async def recall_memories(
    request: Request,
    q: str = Query(..., min_length=1, description="Query to recall relevant memories"),
    limit: int = Query(10, ge=1, le=50, description="Max memories to return"),
) -> dict[str, Any]:
    """Recall relevant memories for the authenticated agent using semantic search."""
    claims = _get_claims(request)
    pool = request.app.state.pool
    agent_id = claims.sub

    # Generate query embedding
    try:
        query_embedding = await generate_embedding(q)
    except Exception:
        return {"memories": [], "error": "Failed to generate query embedding"}

    memories = await memory_store.recall_memories(pool, agent_id, query_embedding, limit=limit)

    return {
        "memories": [
            {"content": m["content"], "score": float(m.get("score", 0)), "created_at": str(m.get("created_at", ""))}
            for m in memories
        ],
        "count": len(memories),
    }
