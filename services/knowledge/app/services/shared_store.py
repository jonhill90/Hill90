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
    base = """SELECT c.*,
               COUNT(DISTINCT s.id) AS source_count,
               COUNT(DISTINCT d.id) AS document_count
           FROM shared_collections c
           LEFT JOIN shared_sources s ON s.collection_id = c.id
           LEFT JOIN shared_documents d ON d.source_id = s.id"""

    if owner is None:
        rows = await pool.fetch(
            f"{base} GROUP BY c.id ORDER BY c.updated_at DESC"
        )
    elif include_shared:
        rows = await pool.fetch(
            f"""{base}
               WHERE c.created_by = $1 OR c.visibility = 'shared'
               GROUP BY c.id ORDER BY c.updated_at DESC""",
            owner,
        )
    else:
        rows = await pool.fetch(
            f"""{base}
               WHERE c.created_by = $1
               GROUP BY c.id ORDER BY c.updated_at DESC""",
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
    duration_ms: int | None = None,
    collection_id: str | None = None,
) -> dict[str, Any]:
    row = await pool.fetchrow(
        """INSERT INTO shared_retrievals
           (query, requester_type, requester_id, agent_owner, result_count, chunk_ids, duration_ms, collection_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *""",
        query,
        requester_type,
        requester_id,
        agent_owner,
        result_count,
        [UUID(cid) for cid in chunk_ids],
        duration_ms,
        UUID(collection_id) if collection_id else None,
    )
    return _serialize(dict(row))


# ---------------------------------------------------------------------------
# Stats (aggregate-only — no raw query text, no requester IDs)
# ---------------------------------------------------------------------------


async def get_shared_stats(
    pool: asyncpg.Pool,
    *,
    since: str | None = None,
) -> dict[str, Any]:
    """Return aggregate quality/ops metrics. No PII, no raw queries."""

    # Search aggregates
    search_row = await pool.fetchrow(
        """SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_count,
                  ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_duration_ms
           FROM shared_retrievals
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)""",
        since,
    )
    total = search_row["total"]
    zero_result_count = search_row["zero_result_count"]
    zero_result_rate = round(zero_result_count / total, 3) if total > 0 else 0.0

    # By requester type (aggregate counts + zero-result breakdown, no IDs)
    type_rows = await pool.fetch(
        """SELECT requester_type,
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE result_count = 0) AS zero_result_count
           FROM shared_retrievals
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
           GROUP BY requester_type""",
        since,
    )
    by_requester_type = []
    for r in type_rows:
        t = r["total"]
        zrc = r["zero_result_count"]
        by_requester_type.append({
            "requester_type": r["requester_type"],
            "total": t,
            "zero_result_count": zrc,
            "zero_result_rate": round(zrc / t, 3) if t > 0 else 0.0,
        })

    # Ingest aggregates
    ingest_row = await pool.fetchrow(
        """SELECT COUNT(*) AS total_jobs,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                  COUNT(*) FILTER (WHERE status = 'running') AS running,
                  COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                  ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
                        FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL))::int
                    AS avg_processing_ms
           FROM shared_ingest_jobs
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)""",
        since,
    )
    total_jobs = ingest_row["total_jobs"]
    failed = ingest_row["failed"]
    ingest_error_rate = round(failed / total_jobs, 3) if total_jobs > 0 else 0.0

    # Source breakdown (current state, not time-scoped)
    status_rows = await pool.fetch(
        "SELECT status, COUNT(*) AS count FROM shared_sources GROUP BY status"
    )
    by_status = {r["status"]: r["count"] for r in status_rows}

    type_source_rows = await pool.fetch(
        "SELECT source_type, COUNT(*) AS count FROM shared_sources GROUP BY source_type"
    )
    by_type = {r["source_type"]: r["count"] for r in type_source_rows}

    # Corpus totals (current state)
    corpus_row = await pool.fetchrow(
        """SELECT (SELECT COUNT(*) FROM shared_collections) AS total_collections,
                  (SELECT COUNT(*) FROM shared_sources) AS total_sources,
                  (SELECT COUNT(*) FROM shared_chunks) AS total_chunks,
                  (SELECT COALESCE(SUM(token_estimate), 0) FROM shared_chunks) AS total_tokens"""
    )

    # Usage analytics — top collections and sources by retrieval count
    top_collections = await pool.fetch(
        """SELECT sc.id, sc.name, COUNT(*) AS retrieval_count
           FROM shared_retrievals sr
           JOIN shared_collections sc ON sr.collection_id = sc.id
           WHERE ($1::timestamptz IS NULL OR sr.created_at >= $1)
             AND sr.collection_id IS NOT NULL
           GROUP BY sc.id, sc.name
           ORDER BY retrieval_count DESC
           LIMIT 10""",
        since,
    )

    top_sources = await pool.fetch(
        """SELECT ss.id, ss.title, sc.name AS collection_name, COUNT(*) AS retrieval_count
           FROM shared_retrievals sr,
                LATERAL unnest(sr.chunk_ids) AS cid
           JOIN shared_chunks sch ON sch.id = cid
           JOIN shared_documents sd ON sch.document_id = sd.id
           JOIN shared_sources ss ON sd.source_id = ss.id
           JOIN shared_collections sc ON ss.collection_id = sc.id
           WHERE ($1::timestamptz IS NULL OR sr.created_at >= $1)
           GROUP BY ss.id, ss.title, sc.name
           ORDER BY retrieval_count DESC
           LIMIT 10""",
        since,
    )

    return {
        "search": {
            "total": total,
            "zero_result_count": zero_result_count,
            "zero_result_rate": zero_result_rate,
            "avg_duration_ms": search_row["avg_duration_ms"],
            "by_requester_type": by_requester_type,
        },
        "ingest": {
            "total_jobs": total_jobs,
            "completed": ingest_row["completed"],
            "failed": failed,
            "running": ingest_row["running"],
            "pending": ingest_row["pending"],
            "error_rate": ingest_error_rate,
            "avg_processing_ms": ingest_row["avg_processing_ms"],
        },
        "sources": {
            "by_status": by_status,
            "by_type": by_type,
        },
        "corpus": {
            "total_collections": corpus_row["total_collections"],
            "total_sources": corpus_row["total_sources"],
            "total_chunks": corpus_row["total_chunks"],
            "total_tokens": corpus_row["total_tokens"],
        },
        "usage": {
            "top_collections": [
                {"id": str(r["id"]), "name": r["name"], "retrieval_count": r["retrieval_count"]}
                for r in top_collections
            ],
            "top_sources": [
                {
                    "id": str(r["id"]),
                    "title": r["title"],
                    "collection_name": r["collection_name"],
                    "retrieval_count": r["retrieval_count"],
                }
                for r in top_sources
            ],
        },
        "since": since,
    }
