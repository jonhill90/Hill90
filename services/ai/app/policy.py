"""DB policy lookup for model authorization and limits.

Given an agent_id, resolves which models the agent is allowed to use and
any rate/budget limits by querying the agents → model_policies tables.
Falls back to the 'default' policy if the agent has none.
If no default exists either, returns empty/deny-all.
"""

import json
from dataclasses import dataclass
from typing import Any


@dataclass
class AgentPolicy:
    """Resolved policy for an agent — models, rate limits, and budget."""
    allowed_models: list[str]
    max_requests_per_minute: int | None
    max_tokens_per_day: int | None


_POLICY_COLUMNS = "mp.id, mp.name, mp.allowed_models, mp.max_requests_per_minute, mp.max_tokens_per_day"

_EMPTY_POLICY = AgentPolicy(allowed_models=[], max_requests_per_minute=None, max_tokens_per_day=None)


async def resolve_agent_policy(conn: Any, *, agent_id: str) -> AgentPolicy:
    """Resolve the full policy for an agent including models and limits.

    Lookup chain:
      1. agents.model_policy_id → model_policies
      2. If agent has no policy, fall back to model_policies WHERE name='default'
      3. If no default, return empty policy (deny all)
    """
    row = await conn.fetchrow(
        f"""
        SELECT {_POLICY_COLUMNS}
        FROM model_policies mp
        JOIN agents a ON a.model_policy_id = mp.id
        WHERE a.agent_id = $1
        """,
        agent_id,
    )

    if row is None:
        row = await conn.fetchrow(
            f"SELECT {_POLICY_COLUMNS} FROM model_policies mp WHERE mp.name = 'default'"
        )

    if row is None:
        return _EMPTY_POLICY

    return AgentPolicy(
        allowed_models=_extract_allowed_models(row),
        max_requests_per_minute=row["max_requests_per_minute"],
        max_tokens_per_day=row["max_tokens_per_day"],
    )


async def resolve_model_policy(conn: Any, *, agent_id: str) -> list[str]:
    """Resolve the list of allowed model names for an agent.

    Convenience wrapper — returns only the model list.
    """
    policy = await resolve_agent_policy(conn, agent_id=agent_id)
    return policy.allowed_models


def _extract_allowed_models(row: Any) -> list[str]:
    """Extract allowed_models from a DB row (handles both list and JSON text)."""
    models = row["allowed_models"]
    if isinstance(models, list):
        return models
    if isinstance(models, str):
        return json.loads(models)
    return []
