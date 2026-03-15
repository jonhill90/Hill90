"""BYOK model resolution — user-owned models and platform model catalog.

Resolves model names to either:
  1. A user model (BYOK path) — returns connection credentials for key injection.
  2. A router model (multi-model BYOK) — returns routing config with per-route credentials.
  3. Neither — model not found.
"""

import json
from dataclasses import dataclass, field
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


@dataclass
class RouterModelInfo:
    """Resolved router model with routing config."""

    strategy: str
    default_route: str
    routes: list[dict] = field(default_factory=list)


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
    """Look up a user-defined single model by name and owner.

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
          AND um.model_type = 'single'
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


async def resolve_router_model(
    conn: Any, model_name: str, owner: str
) -> RouterModelInfo | None:
    """Owner-scoped router model lookup.

    Returns RouterModelInfo with routing config if found, active, and model_type='router'.
    None otherwise.
    """
    row = await conn.fetchrow(
        """SELECT routing_config FROM user_models
           WHERE name = $1 AND created_by = $2 AND model_type = 'router' AND is_active = true""",
        model_name,
        owner,
    )
    if row is None:
        return None

    config = row["routing_config"]
    if isinstance(config, str):
        config = json.loads(config)

    return RouterModelInfo(
        strategy=config.get("strategy", "fallback"),
        default_route=config.get("default_route", ""),
        routes=config.get("routes", []),
    )


async def resolve_route_credentials(
    conn: Any, route: dict, owner: str
) -> UserModelInfo | None:
    """Resolve route credentials with OWNER VALIDATION.

    Defense-in-depth: even though routing_config is owner-scoped at write time,
    validate connection ownership at read time to prevent stale/malformed configs
    from leaking cross-owner credentials.
    """
    connection_id = route.get("connection_id")
    litellm_model = route.get("litellm_model")

    if not connection_id or not litellm_model:
        return None

    row = await conn.fetchrow(
        """SELECT pc.api_key_encrypted, pc.api_key_nonce, pc.api_base_url
           FROM provider_connections pc
           WHERE pc.id = $1 AND pc.created_by = $2""",
        connection_id,
        owner,
    )
    if row is None:
        return None

    return UserModelInfo(
        litellm_model=litellm_model,
        api_key_encrypted=bytes(row["api_key_encrypted"]),
        api_key_nonce=bytes(row["api_key_nonce"]),
        api_base_url=row["api_base_url"],
    )


def select_route(router: RouterModelInfo, task_type: str | None) -> dict | None:
    """Select a route from a router model based on strategy and task_type.

    For task_routing: find route with matching task_type, fall back to default.
    For fallback: return the default route (lowest priority used for retries).
    """
    if not router.routes:
        return None

    if router.strategy == "task_routing" and task_type:
        for route in router.routes:
            if task_type in (route.get("task_types") or []):
                return route

    # Fall back to default route
    for route in router.routes:
        if route.get("key") == router.default_route:
            return route

    # Last resort: first route
    return router.routes[0] if router.routes else None


def get_fallback_route(router: RouterModelInfo, failed_route_key: str) -> dict | None:
    """Get the next route by priority after a failed route.

    Returns the next route with higher priority number (lower priority),
    or None if no fallback available.
    """
    if router.strategy != "fallback":
        return None

    failed_priority = None
    for route in router.routes:
        if route.get("key") == failed_route_key:
            failed_priority = route.get("priority", 0)
            break

    if failed_priority is None:
        return None

    # Find next route by priority (higher number = lower priority)
    candidates = [
        r for r in router.routes
        if r.get("priority", 0) > failed_priority and r.get("key") != failed_route_key
    ]
    if not candidates:
        return None

    return min(candidates, key=lambda r: r.get("priority", 0))


async def is_platform_model(conn: Any, model_name: str) -> bool:
    """Check if a model name exists in the platform model catalog and is active."""
    row = await conn.fetchval(
        "SELECT 1 FROM model_catalog WHERE name = $1 AND is_active = true",
        model_name,
    )
    return row is not None
