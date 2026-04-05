"""Internal admin endpoints for the API proxy layer.

Authenticated with AKM_INTERNAL_SERVICE_TOKEN only. The API service
enforces user-level authorization (ownership/admin scoping) before
calling these endpoints. The knowledge service trusts the API service
to pass the correct agent_id filters.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.services import knowledge_store

router = APIRouter(prefix="/internal/admin", tags=["internal-admin"])


def _verify_service_token(request: Request) -> None:
    """Verify the internal service token from the Authorization header."""
    internal_token = request.app.state.settings.internal_service_token
    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {internal_token}":
        raise HTTPException(status_code=401, detail="invalid service token")


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    """Serialize DB row for JSON response."""
    result = {}
    for key, value in row.items():
        if hasattr(value, "hex"):  # UUID
            result[key] = str(value)
        elif hasattr(value, "isoformat"):  # datetime
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result


@router.get("/agents")
async def list_agents(request: Request) -> list[dict[str, Any]]:
    """List distinct agent_ids with entry counts and last updated timestamps."""
    _verify_service_token(request)
    pool = request.app.state.pool

    rows = await pool.fetch(
        """SELECT agent_id,
                  COUNT(*) AS entry_count,
                  MAX(updated_at) AS last_updated
           FROM knowledge_entries
           WHERE status = 'active'
           GROUP BY agent_id
           ORDER BY last_updated DESC"""
    )

    return [_serialize(dict(r)) for r in rows]


@router.get("/entries")
async def list_entries(
    request: Request,
    agent_id: str = Query(..., description="Agent ID to filter by"),
    type: str | None = Query(None, description="Optional entry type filter"),
) -> list[dict[str, Any]]:
    """List entries for a specific agent, optionally filtered by type."""
    _verify_service_token(request)
    pool = request.app.state.pool

    if type:
        rows = await pool.fetch(
            """SELECT id, agent_id, path, title, entry_type, tags,
                      status, sync_status, created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active' AND entry_type = $2
               ORDER BY updated_at DESC""",
            agent_id,
            type,
        )
    else:
        rows = await pool.fetch(
            """SELECT id, agent_id, path, title, entry_type, tags,
                      status, sync_status, created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active'
               ORDER BY updated_at DESC""",
            agent_id,
        )

    return [_serialize(dict(r)) for r in rows]


@router.get("/entries/{agent_id}/{path:path}")
async def read_entry(
    agent_id: str,
    path: str,
    request: Request,
) -> dict[str, Any]:
    """Read a specific entry by agent_id and path."""
    _verify_service_token(request)
    pool = request.app.state.pool

    row = await pool.fetchrow(
        """SELECT id, agent_id, path, title, entry_type, body AS content,
                  content_hash, tags, status, sync_status, created_at, updated_at
           FROM knowledge_entries
           WHERE agent_id = $1 AND path = $2 AND status = 'active'""",
        agent_id,
        path,
    )

    if row is None:
        raise HTTPException(status_code=404, detail="entry not found")

    return _serialize(dict(row))


@router.get("/search")
async def search_entries(
    request: Request,
    q: str = Query(..., min_length=1, description="Search query"),
    agent_id: str | None = Query(None, description="Optional agent ID filter"),
) -> dict[str, Any]:
    """Search entries, optionally scoped to an agent_id."""
    _verify_service_token(request)
    pool = request.app.state.pool

    if agent_id:
        rows = await pool.fetch(
            """SELECT id, agent_id, path, title, entry_type, tags,
                      ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS score,
                      ts_headline('english', body, websearch_to_tsquery('english', $2),
                                  'StartSel=**, StopSel=**, MaxFragments=3, MaxWords=50') AS headline,
                      created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1
                 AND status = 'active'
                 AND search_vector @@ websearch_to_tsquery('english', $2)
               ORDER BY score DESC
               LIMIT 20""",
            agent_id,
            q,
        )
    else:
        rows = await pool.fetch(
            """SELECT id, agent_id, path, title, entry_type, tags,
                      ts_rank(search_vector, websearch_to_tsquery('english', $1)) AS score,
                      ts_headline('english', body, websearch_to_tsquery('english', $1),
                                  'StartSel=**, StopSel=**, MaxFragments=3, MaxWords=50') AS headline,
                      created_at, updated_at
               FROM knowledge_entries
               WHERE status = 'active'
                 AND search_vector @@ websearch_to_tsquery('english', $1)
               ORDER BY score DESC
               LIMIT 20""",
            q,
        )

    serialized = [_serialize(dict(r)) for r in rows]

    return {
        "query": q,
        "results": serialized,
        "count": len(serialized),
        "search_type": "fts",
        "score_type": "ts_rank",
    }


# ── Journal append (service-to-service) ──────────────────────────────


@dataclass
class _ServiceClaims:
    """Minimal AgentClaims-compatible struct for service-to-service calls."""

    sub: str


class JournalAppendBody(BaseModel):
    content: str


@router.post("/journal/{agent_id}", status_code=201)
async def append_journal(
    agent_id: str,
    body: JournalAppendBody,
    request: Request,
) -> dict[str, Any]:
    """Append to an agent's daily journal (service-to-service).

    Reuses the same date-based, timestamp-batched logic as the
    agent-facing ``POST /api/v1/journal`` endpoint.
    """
    _verify_service_token(request)
    pool = request.app.state.pool
    data_dir = request.app.state.settings.data_dir

    claims = _ServiceClaims(sub=agent_id)
    today = date.today().isoformat()
    journal_path = f"journal/{today}.md"
    now_ts = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

    existing = await knowledge_store.read_entry(pool, claims, journal_path)

    if existing is not None:
        existing_content = existing["content"]
        new_content = f"{existing_content}\n\n## {now_ts}\n\n{body.content}"
        entry = await knowledge_store.update_entry(
            pool, data_dir, claims, journal_path, new_content
        )
        if entry is None:
            raise HTTPException(status_code=500, detail="failed to update journal")
    else:
        frontmatter = (
            f"---\ntitle: Journal {today}\ntype: journal\n---\n\n"
            f"## {now_ts}\n\n{body.content}"
        )
        try:
            entry = await knowledge_store.create_entry(
                pool, data_dir, claims, journal_path, frontmatter
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    return _serialize(entry)
