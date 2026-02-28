"""Metadata-only audit logger for model usage.

Phase 1 logs request metadata only (agent_id, model, timestamp, status, latency_ms).
Token counts and cost are deferred to Phase 2 — columns exist in schema but default to 0.
"""

from typing import Any


async def log_request_metadata(
    *,
    conn: Any,
    agent_id: str,
    model_name: str,
    request_type: str,
    status: str,
    latency_ms: int,
) -> None:
    """Write a metadata-only usage record to model_usage."""
    await conn.execute(
        """
        INSERT INTO model_usage (agent_id, model_name, request_type, status, latency_ms)
        VALUES ($1, $2, $3, $4, $5)
        """,
        agent_id,
        model_name,
        request_type,
        status,
        latency_ms,
    )
