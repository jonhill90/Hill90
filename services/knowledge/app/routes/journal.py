"""Journal route for date-based append operations."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services import knowledge_store

router = APIRouter(prefix="/api/v1/journal", tags=["journal"])


class JournalAppendRequest(BaseModel):
    content: str


@router.post("", status_code=201)
async def append_journal(body: JournalAppendRequest, request: Request) -> dict[str, Any]:
    claims = getattr(request.state, "agent_claims", None)
    if claims is None:
        raise HTTPException(status_code=401, detail="authentication required")

    pool = request.app.state.pool
    data_dir = request.app.state.settings.data_dir

    today = date.today().isoformat()
    journal_path = f"journal/{today}.md"
    now_ts = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

    # Check if today's journal already exists
    existing = await knowledge_store.read_entry(pool, claims, journal_path)

    if existing is not None:
        # Append to existing journal
        existing_content = existing["content"]
        new_content = f"{existing_content}\n\n## {now_ts}\n\n{body.content}"
        entry = await knowledge_store.update_entry(
            pool, data_dir, claims, journal_path, new_content
        )
        if entry is None:
            raise HTTPException(status_code=500, detail="failed to update journal")
    else:
        # Create new journal entry for today
        frontmatter = f"---\ntitle: Journal {today}\ntype: journal\n---\n\n## {now_ts}\n\n{body.content}"
        try:
            entry = await knowledge_store.create_entry(
                pool, data_dir, claims, journal_path, frontmatter
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    return _serialize(entry)


def _serialize(entry: dict[str, Any]) -> dict[str, Any]:
    result = {}
    for key, value in entry.items():
        if hasattr(value, "hex"):
            result[key] = str(value)
        elif hasattr(value, "isoformat"):
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result
