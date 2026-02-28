"""Rate limiting and token budget enforcement for model requests.

All checks query model_usage with status IN ('success', 'error') to exclude
denied requests (rate_limited, budget_exceeded) from counts. This prevents
cascading lockout where denied requests extend enforcement windows.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from dataclasses import dataclass


@dataclass
class RateLimitResult:
    allowed: bool
    count: int
    limit: int
    retry_after: int  # seconds until oldest request in window expires


@dataclass
class BudgetResult:
    allowed: bool
    tokens_used: int
    limit: int
    resets_at: str  # ISO 8601 UTC timestamp


async def check_rate_limit(
    conn: Any, *, agent_id: str, max_rpm: int, delegation_id: str | None = None
) -> RateLimitResult:
    """Check if agent is within rate limit (requests per minute).

    Counts only provider-attempted requests (status IN ('success', 'error')).
    Denied requests are excluded to prevent cascading lockout.

    If delegation_id is provided, counts only requests for that delegation.
    Otherwise counts all requests for the agent (including all delegations).
    """
    if delegation_id:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*) AS cnt,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_secs
            FROM model_usage
            WHERE agent_id = $1
              AND delegation_id = $2
              AND status IN ('success', 'error')
              AND created_at > NOW() - interval '1 minute'
            """,
            agent_id,
            delegation_id,
        )
    else:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*) AS cnt,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_secs
            FROM model_usage
            WHERE agent_id = $1
              AND status IN ('success', 'error')
              AND created_at > NOW() - interval '1 minute'
            """,
            agent_id,
        )

    count = row["cnt"] if row else 0
    oldest_age = row["oldest_age_secs"] if row and row["oldest_age_secs"] is not None else 0
    retry_after = max(0, 60 - oldest_age) if count >= max_rpm else 0

    return RateLimitResult(
        allowed=count < max_rpm,
        count=count,
        limit=max_rpm,
        retry_after=retry_after,
    )


async def check_token_budget(
    conn: Any, *, agent_id: str, max_tokens: int, delegation_id: str | None = None
) -> BudgetResult:
    """Check if agent is within daily token budget.

    Sums tokens from provider-attempted requests only (status IN ('success', 'error')).
    Budget resets at UTC midnight.

    If delegation_id is provided, sums only tokens for that delegation.
    Otherwise sums all tokens for the agent (including all delegations).
    """
    if delegation_id:
        row = await conn.fetchrow(
            """
            SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
            FROM model_usage
            WHERE agent_id = $1
              AND delegation_id = $2
              AND status IN ('success', 'error')
              AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            """,
            agent_id,
            delegation_id,
        )
    else:
        row = await conn.fetchrow(
            """
            SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
            FROM model_usage
            WHERE agent_id = $1
              AND status IN ('success', 'error')
              AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            """,
            agent_id,
        )

    tokens_used = row["total_tokens"] if row else 0

    # Next UTC midnight
    now_utc = datetime.now(timezone.utc)
    today_midnight = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    resets_at = (today_midnight + timedelta(days=1)).isoformat()

    return BudgetResult(
        allowed=tokens_used < max_tokens,
        tokens_used=tokens_used,
        limit=max_tokens,
        resets_at=resets_at,
    )
