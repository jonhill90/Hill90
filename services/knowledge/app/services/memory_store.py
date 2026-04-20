"""Agent persistent memory store.

Stores short memories with vector embeddings for semantic recall.
Each agent has its own memory space, scoped by agent_id.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
from uuid import UUID

import asyncpg

logger = logging.getLogger(__name__)


async def save_memory(
    pool: asyncpg.Pool,
    agent_id: str,
    content: str,
    embedding: list[float],
) -> dict[str, Any]:
    """Save a memory for an agent. Deduplicates by content hash."""
    content_hash = hashlib.sha256(content.strip().encode()).hexdigest()

    row = await pool.fetchrow(
        """INSERT INTO agent_memories (agent_id, content, content_hash, embedding)
           VALUES ($1, $2, $3, $4::vector)
           ON CONFLICT (agent_id, content_hash) DO NOTHING
           RETURNING id, agent_id, content, created_at""",
        agent_id, content.strip(), content_hash, json.dumps(embedding),
    )

    if row is None:
        # Already exists — return existing
        row = await pool.fetchrow(
            "SELECT id, agent_id, content, created_at FROM agent_memories WHERE agent_id = $1 AND content_hash = $2",
            agent_id, content_hash,
        )

    return dict(row) if row else {"agent_id": agent_id, "content": content, "deduplicated": True}


async def recall_memories(
    pool: asyncpg.Pool,
    agent_id: str,
    query_embedding: list[float],
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Recall memories for an agent using cosine similarity search."""
    try:
        rows = await pool.fetch(
            """SELECT id, content, created_at,
                      1 - (embedding <=> $1::vector) AS score
               FROM agent_memories
               WHERE agent_id = $2 AND embedding IS NOT NULL
               ORDER BY embedding <=> $1::vector
               LIMIT $3""",
            json.dumps(query_embedding), agent_id, limit,
        )
        return [dict(r) for r in rows]
    except Exception as e:
        logger.error(f"[memory_store] recall failed: {e}")
        return []
