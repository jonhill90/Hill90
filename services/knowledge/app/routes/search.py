"""Search route for FTS queries."""

from fastapi import APIRouter, HTTPException, Query, Request

from app.services import knowledge_store

router = APIRouter(prefix="/api/v1/search", tags=["search"])


@router.get("")
async def search(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query"),
) -> dict:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    results = await knowledge_store.search_entries(pool, claims, q)

    serialized = []
    for r in results:
        entry: dict = {}
        for key, value in r.items():
            if hasattr(value, "hex"):
                entry[key] = str(value)
            elif hasattr(value, "isoformat"):
                entry[key] = value.isoformat()
            else:
                entry[key] = value
        serialized.append(entry)

    return {
        "query": q,
        "results": serialized,
        "count": len(serialized),
        "search_type": "fts",
        "score_type": "ts_rank",
    }
