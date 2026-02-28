"""Usage logger for model requests with token counts and cost.

Records agent_id, model, status, latency, token counts, and cost per request.
"""

from typing import Any


async def log_usage(
    *,
    conn: Any,
    agent_id: str,
    model_name: str,
    request_type: str,
    status: str,
    latency_ms: int,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
    delegation_id: str | None = None,
) -> None:
    """Write a usage record to model_usage including token counts and cost."""
    await conn.execute(
        """
        INSERT INTO model_usage
            (agent_id, model_name, request_type, status, latency_ms,
             input_tokens, output_tokens, cost_usd, delegation_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        agent_id,
        model_name,
        request_type,
        status,
        latency_ms,
        input_tokens,
        output_tokens,
        cost_usd,
        delegation_id,
    )


# Backwards-compatible alias for Phase 1 callers
log_request_metadata = log_usage
