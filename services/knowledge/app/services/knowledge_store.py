"""Atomic file I/O and knowledge store operations."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import asyncpg
import structlog

from app.middleware.agent_auth import AgentClaims
from app.services.frontmatter import parse_frontmatter
from app.services.path_policy import validate_path

logger = structlog.get_logger()


def _resolve_file_path(data_dir: str, agent_id: str, path: str) -> Path:
    """Resolve an agent-relative path to an absolute file path."""
    return Path(data_dir) / "agents" / agent_id / path


def _resolve_shared_path(data_dir: str, path: str) -> Path:
    """Resolve a shared namespace path to an absolute file path."""
    return Path(data_dir) / "shared" / path


async def atomic_file_write(file_path: Path, content: str) -> None:
    """Write content atomically using tmp+fsync+rename."""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(file_path.parent), suffix=".tmp", prefix=".akm_"
    )
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp_path, str(file_path))
    except Exception:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


async def create_entry(
    pool: asyncpg.Pool,
    data_dir: str,
    claims: AgentClaims,
    path: str,
    content: str,
) -> dict[str, Any]:
    """Create a new knowledge entry (DB-first, then file write).

    Returns the created entry as a dict.
    """
    path = validate_path(path)
    meta, body = parse_frontmatter(content)
    content_hash = hashlib.sha256(content.encode()).hexdigest()

    # DB-first: insert with sync_status='pending'
    row = await pool.fetchrow(
        """INSERT INTO knowledge_entries
           (agent_id, path, title, entry_type, body, content_hash, tags, sync_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING id, agent_id, path, title, entry_type, content_hash, tags,
                     status, sync_status, created_at, updated_at""",
        claims.sub,
        path,
        meta["title"],
        meta["type"],
        content,
        content_hash,
        meta.get("tags", []),
    )

    entry = dict(row)

    # Attempt file write (non-blocking — reconciler catches failures)
    try:
        file_path = _resolve_file_path(data_dir, claims.sub, path)
        await atomic_file_write(file_path, content)
        await pool.execute(
            "UPDATE knowledge_entries SET sync_status = 'synced' WHERE id = $1",
            entry["id"],
        )
        entry["sync_status"] = "synced"
    except Exception:
        logger.warning(
            "file_write_failed_reconciler_will_retry",
            entry_id=str(entry["id"]),
            path=path,
            agent_id=claims.sub,
        )
        # entry["sync_status"] remains "pending" — accurate representation

    return entry


async def read_entry(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    path: str,
) -> dict[str, Any] | None:
    """Read a knowledge entry by path. Returns None if not found or not authorized."""
    path = validate_path(path)
    row = await pool.fetchrow(
        """SELECT id, agent_id, path, title, entry_type, body as content, content_hash,
                  tags, status, sync_status, created_at, updated_at
           FROM knowledge_entries
           WHERE agent_id = $1 AND path = $2 AND status = 'active'""",
        claims.sub,
        path,
    )
    if row is None:
        return None
    return dict(row)


async def read_entry_cross_agent(
    pool: asyncpg.Pool,
    requesting_agent: str,
    owner_agent: str,
    path: str,
) -> dict[str, Any] | None:
    """Attempt to read another agent's entry. Returns None — cross-agent reads are forbidden."""
    return None  # Explicitly forbidden


async def update_entry(
    pool: asyncpg.Pool,
    data_dir: str,
    claims: AgentClaims,
    path: str,
    content: str,
) -> dict[str, Any] | None:
    """Update an existing knowledge entry."""
    path = validate_path(path)
    meta, body = parse_frontmatter(content)
    content_hash = hashlib.sha256(content.encode()).hexdigest()

    row = await pool.fetchrow(
        """UPDATE knowledge_entries
           SET title = $3, entry_type = $4, body = $5, content_hash = $6,
               tags = $7, sync_status = 'pending', updated_at = NOW()
           WHERE agent_id = $1 AND path = $2 AND status = 'active'
           RETURNING id, agent_id, path, title, entry_type, content_hash, tags,
                     status, sync_status, created_at, updated_at""",
        claims.sub,
        path,
        meta["title"],
        meta["type"],
        content,
        content_hash,
        meta.get("tags", []),
    )

    if row is None:
        return None

    entry = dict(row)

    # Attempt file write
    try:
        file_path = _resolve_file_path(data_dir, claims.sub, path)
        await atomic_file_write(file_path, content)
        await pool.execute(
            "UPDATE knowledge_entries SET sync_status = 'synced' WHERE id = $1",
            entry["id"],
        )
        entry["sync_status"] = "synced"
    except Exception:
        logger.warning(
            "file_write_failed_reconciler_will_retry",
            entry_id=str(entry["id"]),
            path=path,
        )
        # entry["sync_status"] remains "pending" — accurate representation

    return entry


async def archive_entry(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    path: str,
) -> dict[str, Any] | None:
    """Soft-delete (archive) an entry."""
    path = validate_path(path)
    row = await pool.fetchrow(
        """UPDATE knowledge_entries
           SET status = 'archived', updated_at = NOW()
           WHERE agent_id = $1 AND path = $2 AND status = 'active'
           RETURNING id, path, status""",
        claims.sub,
        path,
    )
    if row is None:
        return None
    return {"archived": True, "id": row["id"], "path": row["path"]}


async def list_entries(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    entry_type: str | None = None,
) -> list[dict[str, Any]]:
    """List entries for the authenticated agent."""
    if entry_type:
        rows = await pool.fetch(
            """SELECT id, path, title, entry_type, tags, status, sync_status,
                      created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active' AND entry_type = $2
               ORDER BY updated_at DESC""",
            claims.sub,
            entry_type,
        )
    else:
        rows = await pool.fetch(
            """SELECT id, path, title, entry_type, tags, status, sync_status,
                      created_at, updated_at
               FROM knowledge_entries
               WHERE agent_id = $1 AND status = 'active'
               ORDER BY updated_at DESC""",
            claims.sub,
        )
    return [dict(r) for r in rows]


async def search_entries(
    pool: asyncpg.Pool,
    claims: AgentClaims,
    query: str,
) -> list[dict[str, Any]]:
    """Full-text search within the agent's namespace."""
    rows = await pool.fetch(
        """SELECT id, path, title, entry_type, tags,
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
        claims.sub,
        query,
    )
    return [dict(r) for r in rows]
