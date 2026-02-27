"""Internal routes for token management (not exposed to agents)."""

from __future__ import annotations

import hashlib
import time
import uuid
from typing import Any

import jwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.middleware.agent_auth import AuthError, verify_agent_token

router = APIRouter(prefix="/internal", tags=["internal"])


class RefreshRequest(BaseModel):
    refresh_secret: str


class RevokeRequest(BaseModel):
    jti: str
    agent_id: str
    expires_at: int


@router.post("/agents/refresh-token")
async def refresh_token(body: RefreshRequest, request: Request) -> dict[str, Any]:
    """Refresh an agent's JWT using a single-use refresh secret.

    The refresh secret serves as identity proof. On success, returns
    a new token and a new refresh secret (the old secret is invalidated).
    """
    pool = request.app.state.pool
    public_key = request.app.state.public_key
    private_key = request.app.state.private_key

    # Validate the current JWT (allow expired with leeway for refresh window)
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header[7:]
    try:
        # Pass revoked_jtis to prevent revoked tokens from refreshing
        revoked_jtis: set[str] = getattr(request.app.state, "revoked_jtis", set())
        claims = verify_agent_token(token, public_key, revoked_jtis=revoked_jtis)
    except AuthError:
        raise HTTPException(status_code=401, detail="invalid token")

    # Verify the refresh secret against the stored hash
    secret_hash = hashlib.sha256(body.refresh_secret.encode()).hexdigest()

    row = await pool.fetchrow(
        """SELECT id, agent_id, jti, expires_at
           FROM agent_tokens
           WHERE token_hash = $1 AND agent_id = $2 AND revoked_at IS NULL""",
        secret_hash,
        claims.sub,
    )

    if row is None:
        raise HTTPException(status_code=401, detail="invalid refresh secret")

    # Check if expired
    if row["expires_at"].timestamp() < time.time():
        raise HTTPException(status_code=401, detail="refresh token expired")

    # Revoke the old secret (single-use enforcement)
    await pool.execute(
        "UPDATE agent_tokens SET revoked_at = NOW() WHERE id = $1",
        row["id"],
    )

    # Generate new token and secret
    new_jti = str(uuid.uuid4())
    new_secret = str(uuid.uuid4())
    new_secret_hash = hashlib.sha256(new_secret.encode()).hexdigest()
    now = int(time.time())
    new_exp = now + 3600

    # Issue new JWT
    new_token = jwt.encode(
        {
            "sub": claims.sub,
            "iss": "hill90-api",
            "aud": "hill90-akm",
            "exp": new_exp,
            "iat": now,
            "jti": new_jti,
            "scopes": claims.scopes,
        },
        private_key,
        algorithm="EdDSA",
    )

    # Store new token record
    await pool.execute(
        """INSERT INTO agent_tokens (agent_id, jti, token_hash, issued_at, expires_at, rotated_from)
           VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5), $6)""",
        claims.sub,
        new_jti,
        new_secret_hash,
        now,
        new_exp,
        row["id"],
    )

    return {
        "token": new_token,
        "refresh_secret": new_secret,
        "expires_at": new_exp,
    }


@router.post("/revoke")
async def revoke_token(body: RevokeRequest, request: Request) -> dict[str, Any]:
    """Revoke an agent's JWT (called by API service on agent stop).

    Authenticated with internal service token, not agent JWT.
    """
    pool = request.app.state.pool
    internal_token = request.app.state.settings.internal_service_token

    # Verify internal service token
    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {internal_token}":
        raise HTTPException(status_code=401, detail="invalid service token")

    # Insert revocation record

    await pool.execute(
        """INSERT INTO revoked_tokens (jti, agent_id, expires_at)
           VALUES ($1, $2, to_timestamp($3))
           ON CONFLICT (jti) DO NOTHING""",
        body.jti,
        body.agent_id,
        body.expires_at,
    )

    # Also revoke any refresh tokens for this agent
    await pool.execute(
        "UPDATE agent_tokens SET revoked_at = NOW() WHERE agent_id = $1 AND revoked_at IS NULL",
        body.agent_id,
    )

    # Update the in-memory revocation cache
    if hasattr(request.app.state, "revoked_jtis"):
        request.app.state.revoked_jtis.add(body.jti)

    return {"revoked": True, "jti": body.jti}
