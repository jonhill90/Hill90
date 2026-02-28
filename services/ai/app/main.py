"""
Hill90 AI Service — Model Router Gateway

Authenticates agent requests via Ed25519 JWT, enforces model access policy
from DB, and proxies completions through LiteLLM to provider APIs.
"""

import hmac
import time
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import httpx
import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.auth import AuthError, AgentClaims, verify_model_router_token
from app.config import Settings, get_settings, load_public_key
from app.policy import resolve_model_policy
from app.proxy import proxy_chat_completion
from app.revocation import RevocationManager, revocation_manager
from app.usage import log_request_metadata

logger = structlog.get_logger()

# ---- State ----
_db_pool: asyncpg.Pool | None = None
_http_client: httpx.AsyncClient | None = None
_public_key: bytes | None = None


def get_public_key() -> bytes:
    global _public_key
    if _public_key is None:
        _public_key = load_public_key()
    return _public_key


@asynccontextmanager
async def get_db_conn():
    """Acquire a connection from the pool."""
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="Database not connected")
    async with _db_pool.acquire() as conn:
        yield conn


# ---- Lifespan ----
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_pool, _http_client, _public_key

    settings = get_settings()

    # Init DB pool
    if settings.database_url:
        try:
            _db_pool = await asyncpg.create_pool(settings.database_url, min_size=2, max_size=10)
            # Preload revoked JTIs
            async with _db_pool.acquire() as conn:
                await revocation_manager.preload(conn)
            revocation_manager.start_cleanup_loop(_db_pool)
            logger.info("db_connected", pool_size=10)
        except Exception as e:
            logger.error("db_connection_failed", error=str(e))
    else:
        logger.warning("database_url_not_set")

    # Init HTTP client for LiteLLM proxy
    _http_client = httpx.AsyncClient(timeout=120.0)

    # Pre-load public key
    try:
        _public_key = load_public_key()
        logger.info("public_key_loaded")
    except FileNotFoundError:
        logger.warning("public_key_not_found")

    yield

    # Shutdown
    revocation_manager.stop_cleanup_loop()
    if _http_client:
        await _http_client.aclose()
    if _db_pool:
        await _db_pool.close()


app = FastAPI(
    title="Hill90 AI Service — Model Router",
    version="0.2.0",
    lifespan=lifespan,
)


# ---- Auth dependency ----
async def require_agent_auth(authorization: str | None = Header(None)) -> AgentClaims:
    """Extract and verify agent JWT from Authorization header."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")

    token = authorization[7:]
    try:
        public_key = get_public_key()
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Auth not configured")

    try:
        claims = verify_model_router_token(
            token, public_key, revoked_jtis=revocation_manager.revoked_jtis
        )
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))

    return claims


# ---- Endpoints ----

@app.get("/health")
async def health_check():
    """Liveness check — process is running."""
    return {"status": "healthy", "service": "ai"}


@app.get("/health/ready")
async def readiness_check():
    """Readiness check — all dependencies available for authenticated inference."""
    errors = []

    # Check DB pool
    if _db_pool is None:
        errors.append("db_pool_unavailable")
    else:
        try:
            async with _db_pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
        except Exception:
            errors.append("db_query_failed")

    # Check public key loaded
    if _public_key is None:
        errors.append("public_key_not_loaded")

    # Check LiteLLM reachable
    if _http_client is None:
        errors.append("http_client_unavailable")
    else:
        settings = get_settings()
        try:
            resp = await _http_client.get(f"{settings.litellm_url}/health/liveliness", timeout=5.0)
            if resp.status_code >= 400:
                errors.append("litellm_unhealthy")
        except Exception:
            errors.append("litellm_unreachable")

    if errors:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "service": "ai", "errors": errors},
        )
    return {"status": "ready", "service": "ai"}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, claims: AgentClaims = Depends(require_agent_auth)):
    """Proxy chat completion to LiteLLM after policy check."""
    settings = get_settings()
    body = await request.json()
    requested_model = body.get("model", "")

    # Policy check from DB
    async with get_db_conn() as conn:
        allowed_models = await resolve_model_policy(conn, agent_id=claims.sub)

    if requested_model not in allowed_models:
        raise HTTPException(
            status_code=403,
            detail=f"Model '{requested_model}' not authorized for agent '{claims.sub}'",
        )

    # Proxy to LiteLLM
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    start = time.monotonic()
    try:
        result = await proxy_chat_completion(
            client=_http_client,
            litellm_url=settings.litellm_url,
            litellm_master_key=settings.litellm_master_key,
            request_body=body,
        )
    except Exception as e:
        # Log failed request
        elapsed_ms = int((time.monotonic() - start) * 1000)
        async with get_db_conn() as conn:
            await log_request_metadata(
                conn=conn,
                agent_id=claims.sub,
                model_name=requested_model,
                request_type="chat.completion",
                status="error",
                latency_ms=elapsed_ms,
            )
        logger.error("proxy_error", agent_id=claims.sub, model=requested_model, error=str(e))
        raise HTTPException(status_code=502, detail="LiteLLM proxy error")

    elapsed_ms = int((time.monotonic() - start) * 1000)
    status = "success" if result["status_code"] == 200 else "error"

    # Log metadata (no token counts or cost in Phase 1)
    try:
        async with get_db_conn() as conn:
            await log_request_metadata(
                conn=conn,
                agent_id=claims.sub,
                model_name=requested_model,
                request_type="chat.completion",
                status=status,
                latency_ms=elapsed_ms,
            )
    except Exception as e:
        logger.warning("usage_log_failed", error=str(e))

    return JSONResponse(content=result["body"], status_code=result["status_code"])


@app.get("/v1/models")
async def list_models(claims: AgentClaims = Depends(require_agent_auth)):
    """Return models allowed by agent's DB policy (OpenAI-compatible format)."""
    async with get_db_conn() as conn:
        allowed_models = await resolve_model_policy(conn, agent_id=claims.sub)

    return {
        "object": "list",
        "data": [
            {"id": model, "object": "model", "owned_by": "hill90"}
            for model in allowed_models
        ],
    }


class RevokeRequest(BaseModel):
    jti: str
    agent_id: str
    expires_at: int


@app.post("/internal/revoke")
async def revoke_token(body: RevokeRequest, authorization: str = Header(...)):
    """Revoke a model-router JWT. Authenticated via internal service token."""
    settings = get_settings()

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=403, detail="Missing Bearer token")

    token = authorization[7:]
    if not hmac.compare_digest(token, settings.model_router_internal_service_token):
        raise HTTPException(status_code=403, detail="Invalid service token")

    async with get_db_conn() as conn:
        await revocation_manager.revoke(
            conn, jti=body.jti, agent_id=body.agent_id, expires_at=body.expires_at
        )

    logger.info("token_revoked", jti=body.jti, agent_id=body.agent_id)
    return {"status": "revoked", "jti": body.jti}
