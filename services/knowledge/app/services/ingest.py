"""Ingest orchestration for shared knowledge sources.

Validates content, creates ingest job, runs chunker, stores chunks,
and updates job/source status. Synchronous in V1 (async-ready interface).
"""

from __future__ import annotations

import hashlib
from typing import Any

import asyncpg
import structlog

from app.services import shared_store
from app.services.text_chunker import MAX_SOURCE_SIZE, Chunk, chunk_markdown, chunk_text
from app.services.web_page_fetcher import FetchError, fetch_and_extract

logger = structlog.get_logger()


class IngestError(Exception):
    """Raised when ingestion fails validation."""


async def ingest_source(
    pool: asyncpg.Pool,
    *,
    collection_id: str,
    title: str,
    source_type: str,
    raw_content: str,
    source_url: str | None = None,
    created_by: str,
) -> dict[str, Any]:
    """Ingest a new source into a collection.

    Creates source, ingest job, runs chunker, stores document + chunks.
    Returns the source with ingest job summary.

    For web_page sources, the fetch happens after source/job creation so
    that failures leave a source record in error state (visible in UI)
    rather than returning a bare 422 with no DB record.
    """
    if source_type not in ("text", "markdown", "web_page"):
        raise IngestError(f"unsupported source_type: {source_type}")

    # Pre-validation (before any DB writes)
    if source_type == "web_page":
        if not source_url or not source_url.strip():
            raise IngestError("source_url is required for web_page sources")
        # Placeholder — real content fetched after source/job records exist
        raw_content = ""
        content_hash = ""
    else:
        if not raw_content or not raw_content.strip():
            raise IngestError("content is required for text/markdown sources")

        if len(raw_content.encode()) > MAX_SOURCE_SIZE:
            raise IngestError(
                f"content exceeds maximum size of {MAX_SOURCE_SIZE // 1024}KB"
            )

        content_hash = hashlib.sha256(raw_content.encode()).hexdigest()

    # Create source record
    source = await shared_store.create_source(
        pool,
        collection_id=collection_id,
        title=title,
        source_type=source_type,
        raw_content=raw_content,
        content_hash=content_hash,
        source_url=source_url,
        created_by=created_by,
    )

    # Create ingest job
    job = await shared_store.create_ingest_job(pool, source["id"])

    try:
        # Mark job as running
        await shared_store.update_ingest_job(pool, job["id"], status="running")

        # Web page: fetch and extract content now (after source/job exist)
        if source_type == "web_page":
            result = await fetch_and_extract(source_url)
            raw_content = result["content"]
            if not title or title.strip() == source_url:
                title = result.get("title", title)
            content_hash = hashlib.sha256(raw_content.encode()).hexdigest()

            if len(raw_content.encode()) > MAX_SOURCE_SIZE:
                raise IngestError(
                    f"extracted content exceeds maximum size of {MAX_SOURCE_SIZE // 1024}KB"
                )

        # Run chunker
        chunks: list[Chunk]
        if source_type == "markdown":
            chunks = chunk_markdown(raw_content)
        else:  # text and web_page
            chunks = chunk_text(raw_content)

        if not chunks:
            raise IngestError("content produced zero chunks after processing")

        # Create document
        document = await shared_store.create_document(
            pool,
            source_id=source["id"],
            ingest_job_id=job["id"],
            title=title,
            content_hash=content_hash,
            chunk_count=len(chunks),
        )

        # Store chunks
        chunk_tuples = [
            (c.index, c.content, c.token_estimate) for c in chunks
        ]
        await shared_store.create_chunks(pool, document["id"], chunk_tuples)

        # Mark job completed
        await shared_store.update_ingest_job(
            pool, job["id"], status="completed", chunk_count=len(chunks)
        )

        # Mark source active
        await shared_store.update_source_status(
            pool, source["id"], status="active"
        )

        logger.info(
            "ingest_completed",
            source_id=source["id"],
            chunk_count=len(chunks),
        )

        # Strip raw_content from response to avoid sending large payloads
        source_response = {k: v for k, v in source.items() if k != "raw_content"}

        return {
            "source": {**source_response, "status": "active"},
            "ingest_job": {
                "id": job["id"],
                "status": "completed",
                "chunk_count": len(chunks),
            },
            "document": {
                "id": document["id"],
                "title": document["title"],
                "chunk_count": document["chunk_count"],
            },
        }

    except Exception as exc:
        error_msg = str(exc)
        logger.error(
            "ingest_failed",
            source_id=source["id"],
            job_id=job["id"],
            error=error_msg,
        )

        await shared_store.update_ingest_job(
            pool, job["id"], status="failed", error_message=error_msg
        )
        await shared_store.update_source_status(
            pool, source["id"], status="error", error_message=error_msg
        )

        source_err = {k: v for k, v in source.items() if k != "raw_content"}

        return {
            "source": {**source_err, "status": "error", "error_message": error_msg},
            "ingest_job": {
                "id": job["id"],
                "status": "failed",
                "error_message": error_msg,
            },
        }
