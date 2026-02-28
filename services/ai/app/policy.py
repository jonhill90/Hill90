"""DB policy lookup for model authorization.

Given an agent_id, resolves which models the agent is allowed to use by
querying the agents table for model_policy_id, then the model_policies table
for allowed_models. Falls back to the 'default' policy if the agent has none.
If no default exists either, returns empty list (fail closed).
"""

import json
from typing import Any


async def resolve_model_policy(conn: Any, *, agent_id: str) -> list[str]:
    """Resolve the list of allowed model names for an agent.

    Lookup chain:
      1. agents.model_policy_id → model_policies.allowed_models
      2. If agent has no policy, fall back to model_policies WHERE name='default'
      3. If no default, return [] (deny all)

    Returns a list of allowed model name strings.
    """
    # Try agent's assigned policy first
    row = await conn.fetchrow(
        """
        SELECT mp.id, mp.name, mp.allowed_models
        FROM model_policies mp
        JOIN agents a ON a.model_policy_id = mp.id
        WHERE a.agent_id = $1
        """,
        agent_id,
    )

    if row is not None:
        return _extract_allowed_models(row)

    # Fallback to default policy
    row = await conn.fetchrow(
        "SELECT id, name, allowed_models FROM model_policies WHERE name = 'default'"
    )

    if row is not None:
        return _extract_allowed_models(row)

    # No policy at all — fail closed
    return []


def _extract_allowed_models(row: Any) -> list[str]:
    """Extract allowed_models from a DB row (handles both list and JSON text)."""
    models = row["allowed_models"]
    if isinstance(models, list):
        return models
    # asyncpg returns JSONB as Python objects, but handle string fallback
    if isinstance(models, str):
        return json.loads(models)
    return []
