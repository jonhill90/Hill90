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
    """Resolved policy for an agent — models, rate limits, budget, and aliases."""
    allowed_models: list[str]
    max_requests_per_minute: int | None
    max_tokens_per_day: int | None
    model_aliases: dict[str, str] | None = None


_POLICY_COLUMNS = "mp.id, mp.name, mp.allowed_models, mp.max_requests_per_minute, mp.max_tokens_per_day, mp.model_aliases"

_EMPTY_POLICY = AgentPolicy(allowed_models=[], max_requests_per_minute=None, max_tokens_per_day=None, model_aliases=None)


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
        model_aliases=_extract_model_aliases(row),
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


def _extract_model_aliases(row: Any) -> dict[str, str] | None:
    """Extract model_aliases from a DB row (handles dict, JSON text, or None)."""
    aliases = row.get("model_aliases")
    if aliases is None:
        return None
    if isinstance(aliases, dict):
        return aliases
    if isinstance(aliases, str):
        parsed = json.loads(aliases)
        return parsed if isinstance(parsed, dict) else None
    return None


def resolve_alias(requested_model: str, policy: AgentPolicy) -> str:
    """Resolve a model alias to its real model name.

    Single-pass lookup — no recursion. If the requested name is found in
    the policy's model_aliases, returns the target. Otherwise returns the
    requested name unchanged (treated as a literal model name).
    """
    if policy.model_aliases and requested_model in policy.model_aliases:
        return policy.model_aliases[requested_model]
    return requested_model


def resolve_aliases_list(models: list[str], policy: AgentPolicy) -> list[str]:
    """Resolve a list of model names/aliases to real model names."""
    return [resolve_alias(m, policy) for m in models]
