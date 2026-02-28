"""Delegation management for subagent narrowing.

Provides endpoints for creating, listing, and revoking delegations.
A delegation binds a child JWT to a restricted subset of the parent's
permissions (models, rate limits, budget).
"""

import json
import uuid
from dataclasses import dataclass
from typing import Any

import structlog

from app.auth import AgentClaims
from app.policy import AgentPolicy

logger = structlog.get_logger()


@dataclass
class Delegation:
    """A delegation record from the database."""
    id: str
    parent_agent_id: str
    parent_jti: str
    child_jti: str
    child_label: str
    allowed_models: list[str]
    max_requests_per_minute: int | None
    max_tokens_per_day: int | None
    expires_at: int
    revoked_at: str | None
    created_at: str


@dataclass
class EffectivePolicy:
    """Computed effective policy for a delegated request."""
    allowed_models: list[str]
    max_requests_per_minute: int | None
    max_tokens_per_day: int | None
    delegation_id: str


def validate_narrowing(
    parent_policy: AgentPolicy,
    allowed_models: list[str],
    max_rpm: int | None,
    max_tpd: int | None,
) -> list[str]:
    """Validate that delegation constraints are a strict subset of parent policy.

    Returns a list of violation messages. Empty list means valid.
    """
    violations = []

    # Models must be a subset of parent's allowed models
    for model in allowed_models:
        if model not in parent_policy.allowed_models:
            violations.append(f"model '{model}' not in parent's allowed_models")

    # Rate limit must not exceed parent's
    if max_rpm is not None and parent_policy.max_requests_per_minute is not None:
        if max_rpm > parent_policy.max_requests_per_minute:
            violations.append(
                f"max_requests_per_minute {max_rpm} exceeds parent's limit of {parent_policy.max_requests_per_minute}"
            )

    # Budget must not exceed parent's
    if max_tpd is not None and parent_policy.max_tokens_per_day is not None:
        if max_tpd > parent_policy.max_tokens_per_day:
            violations.append(
                f"max_tokens_per_day {max_tpd} exceeds parent's limit of {parent_policy.max_tokens_per_day}"
            )

    return violations


async def create_delegation(
    conn: Any,
    *,
    parent_claims: AgentClaims,
    parent_policy: AgentPolicy,
    child_label: str,
    allowed_models: list[str],
    max_rpm: int | None,
    max_tpd: int | None,
    expires_at: int | None,
) -> dict[str, Any]:
    """Create a delegation record in the database.

    Expects allowed_models to be pre-resolved (aliases already resolved by caller).
    Caps expiry to parent JWT expiry.
    Returns dict with id, allowed_models, max_rpm, max_tpd, expires_at.
    """
    # Cap expiry to parent JWT expiry
    effective_expires = parent_claims.exp
    if expires_at is not None:
        effective_expires = min(expires_at, parent_claims.exp)

    delegation_id = str(uuid.uuid4())

    await conn.execute(
        """
        INSERT INTO model_delegations
            (id, parent_agent_id, parent_jti, child_jti, child_label,
             allowed_models, max_requests_per_minute, max_tokens_per_day,
             expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        """,
        delegation_id,
        parent_claims.sub,
        parent_claims.jti,
        f"pending-{delegation_id}",  # unique placeholder — updated after API service signs the child JWT
        child_label,
        json.dumps(allowed_models),
        max_rpm,
        max_tpd,
        effective_expires,
    )

    return {
        "id": delegation_id,
        "allowed_models": allowed_models,
        "max_requests_per_minute": max_rpm,
        "max_tokens_per_day": max_tpd,
        "expires_at": effective_expires,
    }


async def update_child_jti(conn: Any, *, delegation_id: str, child_jti: str) -> None:
    """Update the child_jti on a delegation record after JWT signing."""
    await conn.execute(
        "UPDATE model_delegations SET child_jti = $1 WHERE id = $2",
        child_jti,
        delegation_id,
    )


async def lookup_delegation(conn: Any, *, delegation_id: str, agent_id: str) -> Delegation | None:
    """Look up an active delegation record by ID and parent agent."""
    row = await conn.fetchrow(
        """
        SELECT id, parent_agent_id, parent_jti, child_jti, child_label,
               allowed_models, max_requests_per_minute, max_tokens_per_day,
               expires_at, revoked_at, created_at
        FROM model_delegations
        WHERE id = $1 AND parent_agent_id = $2
        """,
        delegation_id,
        agent_id,
    )
    if row is None:
        return None
    return _row_to_delegation(row)


async def lookup_delegation_by_id(conn: Any, *, delegation_id: str) -> Delegation | None:
    """Look up a delegation record by ID (for child request authorization)."""
    row = await conn.fetchrow(
        """
        SELECT id, parent_agent_id, parent_jti, child_jti, child_label,
               allowed_models, max_requests_per_minute, max_tokens_per_day,
               expires_at, revoked_at, created_at
        FROM model_delegations
        WHERE id = $1
        """,
        delegation_id,
    )
    if row is None:
        return None
    return _row_to_delegation(row)


async def list_delegations(conn: Any, *, agent_id: str) -> list[dict[str, Any]]:
    """List all delegations for a parent agent."""
    rows = await conn.fetch(
        """
        SELECT id, parent_agent_id, parent_jti, child_jti, child_label,
               allowed_models, max_requests_per_minute, max_tokens_per_day,
               expires_at, revoked_at, created_at
        FROM model_delegations
        WHERE parent_agent_id = $1
        ORDER BY created_at ASC
        """,
        agent_id,
    )
    return [
        {
            "id": str(row["id"]),
            "child_label": row["child_label"],
            "allowed_models": _parse_models(row["allowed_models"]),
            "max_requests_per_minute": row["max_requests_per_minute"],
            "max_tokens_per_day": row["max_tokens_per_day"],
            "expires_at": row["expires_at"],
            "revoked_at": str(row["revoked_at"]) if row["revoked_at"] else None,
            "created_at": str(row["created_at"]),
        }
        for row in rows
    ]


async def revoke_delegation(conn: Any, *, delegation_id: str, agent_id: str) -> Delegation | None:
    """Revoke a delegation. Returns the delegation if found, None otherwise."""
    row = await conn.fetchrow(
        """
        UPDATE model_delegations
        SET revoked_at = NOW()
        WHERE id = $1 AND parent_agent_id = $2 AND revoked_at IS NULL
        RETURNING id, parent_agent_id, parent_jti, child_jti, child_label,
                  allowed_models, max_requests_per_minute, max_tokens_per_day,
                  expires_at, revoked_at, created_at
        """,
        delegation_id,
        agent_id,
    )
    if row is None:
        return None
    return _row_to_delegation(row)


def compute_effective_policy(
    parent_policy: AgentPolicy,
    delegation: Delegation,
) -> EffectivePolicy:
    """Compute the effective policy as intersection of parent policy and delegation."""
    effective_models = [
        m for m in delegation.allowed_models
        if m in parent_policy.allowed_models
    ]

    effective_rpm = _min_non_null(
        parent_policy.max_requests_per_minute,
        delegation.max_requests_per_minute,
    )

    effective_tpd = _min_non_null(
        parent_policy.max_tokens_per_day,
        delegation.max_tokens_per_day,
    )

    return EffectivePolicy(
        allowed_models=effective_models,
        max_requests_per_minute=effective_rpm,
        max_tokens_per_day=effective_tpd,
        delegation_id=str(delegation.id),
    )


def _min_non_null(a: int | None, b: int | None) -> int | None:
    """Return the minimum of two optional ints, treating None as unlimited."""
    if a is None and b is None:
        return None
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


def _parse_models(value: Any) -> list[str]:
    """Parse allowed_models from DB (handles list, JSON string)."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return json.loads(value)
    return []


def _row_to_delegation(row: Any) -> Delegation:
    """Convert a DB row to a Delegation dataclass."""
    return Delegation(
        id=str(row["id"]),
        parent_agent_id=row["parent_agent_id"],
        parent_jti=row["parent_jti"],
        child_jti=row["child_jti"],
        child_label=row["child_label"],
        allowed_models=_parse_models(row["allowed_models"]),
        max_requests_per_minute=row["max_requests_per_minute"],
        max_tokens_per_day=row["max_tokens_per_day"],
        expires_at=row["expires_at"],
        revoked_at=str(row["revoked_at"]) if row["revoked_at"] else None,
        created_at=str(row["created_at"]),
    )
