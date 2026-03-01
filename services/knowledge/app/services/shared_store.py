"""Database operations for the Shared Knowledge Base.

Collections, sources, ingest jobs, documents, chunks, and retrieval audit.
Follows patterns established in knowledge_store.py.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import asyncpg
import structlog

logger = structlog.get_logger()


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    """Serialize DB row for JSON response."""
    result = {}
    for key, value in row.items():
        if hasattr(value, "hex"):  # UUID
            result[key] = str(value)
        elif hasattr(value, "isoformat"):  # datetime
            result[key] = value.isoformat()
        elif isinstance(value, list):
            result[key] = [str(v) if hasattr(v, "hex") else v for v in value]
        else:
            result[key] = value
    return result


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------


async def create_collection(
    pool: asyncpg.Pool,
    *,
    name: str,
    description: str,
    visibility: str,
    created_by: str,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_collections (name, description, visibility, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING *""",
        name,
        description,
        visibility,
        created_by,
    )
    return _serialize(dict(row))


async def list_collections(
    pool: asyncpg.Pool,
    *,
    owner: str | None = None,
    include_shared: bool = True,
) -> list[dict[str, Any]]:
    """List collections visible to the given owner.

    If owner is None, return all collections (admin).
    Otherwise return owner's private + all shared.
    """
    if owner is None:
        rows = await pool.fetch(
            "SELECT * FROM shared_collections ORDER BY updated_at DESC"
        )
    elif include_shared:
        rows = await pool.fetch(
            """SELECT * FROM shared_collections
               WHERE created_by = $1 OR visibility = 'shared'
               ORDER BY updated_at DESC""",
            owner,
        )
    else:
        rows = await pool.fetch(
            """SELECT * FROM shared_collections
               WHERE created_by = $1
               ORDER BY updated_at DESC""",
            owner,
        )
    return [_serialize(dict(r)) for r in rows]


async def get_collection(
    pool: asyncpg.Pool, collection_id: str
) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT * FROM shared_collections WHERE id = $1",
        UUID(collection_id),
    )
    return _serialize(dict(row)) if row else None


async def update_collection(
    pool: asyncpg.Pool,
    collection_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    visibility: str | None = None,
) -> dict[str, Any] | None:
    # Build dynamic SET clause
    sets: list[str] = ["updated_at = NOW()"]
    params: list[Any] = []
    idx = 1

    if name is not None:
        sets.append(f"name = ${idx}")
        params.append(name)
        idx += 1
    if description is not None:
        sets.append(f"description = ${idx}")
        params.append(description)
        idx += 1
    if visibility is not None:
        sets.append(f"visibility = ${idx}")
        params.append(visibility)
        idx += 1

    params.append(UUID(collection_id))
    row = await pool.fetchrow(
        f"UPDATE shared_collections SET {', '.join(sets)} WHERE id = ${idx} RETURNING *",
        *params,
    )
    return _serialize(dict(row)) if row else None


async def delete_collection(pool: asyncpg.Pool, collection_id: str) -> bool:
    result = await pool.execute(
        "DELETE FROM shared_collections WHERE id = $1",
        UUID(collection_id),
    )
    return result == "DELETE 1"


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


async def create_source(
    pool: asyncpg.Pool,
    *,
    collection_id: str,
    title: str,
    source_type: str,
    raw_content: str | None,
    content_hash: str,
    source_url: str | None = None,
    created_by: str,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_sources
           (collection_id, title, source_type, source_url, raw_content, content_hash, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *""",
        UUID(collection_id),
        title,
        source_type,
        source_url,
        raw_content,
        content_hash,
        created_by,
    )
    return _serialize(dict(row))


async def get_source(pool: asyncpg.Pool, source_id: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT * FROM shared_sources WHERE id = $1",
        UUID(source_id),
    )
    return _serialize(dict(row)) if row else None


async def list_sources(
    pool: asyncpg.Pool, collection_id: str
) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """SELECT id, collection_id, title, source_type, source_url,
                  content_hash, status, error_message, created_by, created_at, updated_at
           FROM shared_sources
           WHERE collection_id = $1
           ORDER BY created_at DESC""",
        UUID(collection_id),
    )
    return [_serialize(dict(r)) for r in rows]


async def update_source_status(
    pool: asyncpg.Pool,
    source_id: str,
    *,
    status: str,
    error_message: str | None = None,
) -> None:
    await pool.execute(
        """UPDATE shared_sources
           SET status = $2, error_message = $3, updated_at = NOW()
           WHERE id = $1""",
        UUID(source_id),
        status,
        error_message,
    )


async def delete_source(pool: asyncpg.Pool, source_id: str) -> bool:
    result = await pool.execute(
        "DELETE FROM shared_sources WHERE id = $1",
        UUID(source_id),
    )
    return result == "DELETE 1"


# ---------------------------------------------------------------------------
# Ingest Jobs
# ---------------------------------------------------------------------------


async def create_ingest_job(
    pool: asyncpg.Pool, source_id: str
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_ingest_jobs (source_id)
           VALUES ($1) RETURNING *""",
        UUID(source_id),
    )
    return _serialize(dict(row))


async def update_ingest_job(
    pool: asyncpg.Pool,
    job_id: str,
    *,
    status: str,
    chunk_count: int | None = None,
    error_message: str | None = None,
) -> None:
    if status == "running":
        await pool.execute(
            """UPDATE shared_ingest_jobs
               SET status = 'running', started_at = NOW()
               WHERE id = $1""",
            UUID(job_id),
        )
    elif status == "completed":
        await pool.execute(
            """UPDATE shared_ingest_jobs
               SET status = 'completed', completed_at = NOW(), chunk_count = $2
               WHERE id = $1""",
            UUID(job_id),
            chunk_count or 0,
        )
    elif status == "failed":
        await pool.execute(
            """UPDATE shared_ingest_jobs
               SET status = 'failed', completed_at = NOW(), error_message = $2
               WHERE id = $1""",
            UUID(job_id),
            error_message,
        )


# ---------------------------------------------------------------------------
# Documents & Chunks
# ---------------------------------------------------------------------------


async def create_document(
    pool: asyncpg.Pool,
    *,
    source_id: str,
    ingest_job_id: str,
    title: str,
    content_hash: str,
    chunk_count: int,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_documents
           (source_id, ingest_job_id, title, content_hash, chunk_count)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *""",
        UUID(source_id),
        UUID(ingest_job_id),
        title,
        content_hash,
        chunk_count,
    )
    return _serialize(dict(row))


async def create_chunks(
    pool: asyncpg.Pool,
    document_id: str,
    chunks: list[tuple[int, str, int]],
) -> int:
    """Bulk-insert chunks. Each tuple is (chunk_index, content, token_estimate).

    Returns the number of chunks inserted.
    """
    doc_uuid = UUID(document_id)
    records = [
        (doc_uuid, idx, content, tokens)
        for idx, content, tokens in chunks
    ]
    await pool.executemany(
        """INSERT INTO shared_chunks (document_id, chunk_index, content, token_estimate)
           VALUES ($1, $2, $3, $4)""",
        records,
    )
    return len(records)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


async def search_chunks(
    pool: asyncpg.Pool,
    query: str,
    *,
    owner: str | None = None,
    collection_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Full-text search across shared chunks with visibility scoping.

    owner=None means admin (sees all).
    owner=<sub> means see owner's private + all shared.
    """
    params: list[Any] = [query]
    conditions = [
        "sch.search_vector @@ websearch_to_tsquery('english', $1)",
    ]
    idx = 2

    if owner is not None:
        conditions.append(
            f"(sc.created_by = ${idx} OR sc.visibility = 'shared')"
        )
        params.append(owner)
        idx += 1

    if collection_id is not None:
        conditions.append(f"sc.id = ${idx}")
        params.append(UUID(collection_id))
        idx += 1

    where = " AND ".join(conditions)
    params.append(limit)

    rows = await pool.fetch(
        f"""SELECT
                sch.id AS chunk_id,
                sch.content,
                sch.chunk_index,
                sch.token_estimate,
                ts_rank(sch.search_vector, websearch_to_tsquery('english', $1)) AS score,
                ts_headline('english', sch.content, websearch_to_tsquery('english', $1),
                            'StartSel=**, StopSel=**, MaxFragments=3, MaxWords=50') AS headline,
                sd.id AS document_id,
                sd.title AS document_title,
                ss.id AS source_id,
                ss.title AS source_title,
                ss.source_url,
                sc.id AS collection_id,
                sc.name AS collection_name
            FROM shared_chunks sch
            JOIN shared_documents sd ON sch.document_id = sd.id
            JOIN shared_sources ss ON sd.source_id = ss.id
            JOIN shared_collections sc ON ss.collection_id = sc.id
            WHERE {where}
              AND ss.status = 'active'
            ORDER BY score DESC
            LIMIT ${idx}""",
        *params,
    )

    return [_serialize(dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# Retrieval Audit
# ---------------------------------------------------------------------------


async def record_retrieval(
    pool: asyncpg.Pool,
    *,
    query: str,
    requester_type: str,
    requester_id: str,
    agent_owner: str | None = None,
    result_count: int,
    chunk_ids: list[str],
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_retrievals
           (query, requester_type, requester_id, agent_owner, result_count, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *""",
        query,
        requester_type,
        requester_id,
        agent_owner,
        result_count,
        [UUID(cid) for cid in chunk_ids],
    )
    return _serialize(dict(row))
