"""BYOK model resolution — user-owned models and platform model catalog.

Resolves model names to either:
  1. A user model (BYOK path) — returns connection credentials for key injection.
  2. A platform model (catalog path) — returns None, existing LiteLLM config handles routing.
  3. Neither — model not found.
"""

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import structlog
import time

logger = structlog.get_logger()


@dataclass
class UserModelInfo:
    """Resolved user model with connection details for BYOK key injection."""

    litellm_model: str
    api_key_encrypted: bytes
    api_key_nonce: bytes
    api_base_url: str | None


# Simple in-memory cache for agent owner lookups (agent_id → (owner, expires_at))
_owner_cache: dict[str, tuple[str, float]] = {}
_OWNER_CACHE_TTL = 60.0  # seconds


async def get_agent_owner(conn: Any, agent_id: str) -> str | None:
    """Look up the owner (created_by) of an agent, with in-memory caching.

    Returns the owner's user sub, or None if the agent is not found.
    Cache TTL is 60 seconds per agent_id.
    """
    now = time.monotonic()
    cached = _owner_cache.get(agent_id)
    if cached is not None:
        owner, expires_at = cached
        if now < expires_at:
            return owner

    row = await conn.fetchrow(
        "SELECT created_by FROM agents WHERE agent_id = $1", agent_id
    )
    if row is None:
        return None

    owner = row["created_by"]
    _owner_cache[agent_id] = (owner, now + _OWNER_CACHE_TTL)
    return owner


def clear_owner_cache() -> None:
    """Clear the agent owner cache (for testing)."""
    _owner_cache.clear()


async def resolve_user_model(
    conn: Any, model_name: str, owner: str
) -> UserModelInfo | None:
    """Look up a user-defined model by name and owner.

    Returns UserModelInfo with connection credentials if found and active,
    None otherwise. Joins user_models with provider_connections to get
    the encrypted API key in a single query.
    """
    row = await conn.fetchrow(
        """
        SELECT um.litellm_model,
               pc.api_key_encrypted,
               pc.api_key_nonce,
               pc.api_base_url
        FROM user_models um
        JOIN provider_connections pc ON um.connection_id = pc.id
        WHERE um.name = $1
          AND um.created_by = $2
          AND um.is_active = true
        """,
        model_name,
        owner,
    )
    if row is None:
        return None

    return UserModelInfo(
        litellm_model=row["litellm_model"],
        api_key_encrypted=bytes(row["api_key_encrypted"]),
        api_key_nonce=bytes(row["api_key_nonce"]),
        api_base_url=row["api_base_url"],
    )


async def is_platform_model(conn: Any, model_name: str) -> bool:
    """Check if a model name exists in the platform model catalog and is active."""
    row = await conn.fetchval(
        "SELECT 1 FROM model_catalog WHERE name = $1 AND is_active = true",
        model_name,
    )
    return row is not None
