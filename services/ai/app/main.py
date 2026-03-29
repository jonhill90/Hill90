"""
Hill90 AI Service — Model Router Gateway

Authenticates agent requests via Ed25519 JWT, enforces model access policy
from DB, and proxies completions through LiteLLM to provider APIs.
"""

import hmac
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import anyio
import asyncpg
import httpx
import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.auth import AuthError, AgentClaims, verify_model_router_token
from app.config import Settings, get_settings, load_public_key
from app.crypto import decrypt_provider_key
from app.delegation import (
    compute_effective_policy,
    create_delegation,
    list_delegations,
    lookup_delegation_by_id,
    revoke_delegation,
    update_child_jti,
    validate_narrowing,
)
from app.limits import check_rate_limit, check_token_budget
from app.model_type_detect import detect_model_type
from app.models import (
    get_agent_owner,
    get_fallback_route,
    is_platform_model,
    resolve_platform_model,
    resolve_route_credentials,
    resolve_router_model,
    resolve_user_model,
    RouterModelInfo,
    select_route,
    UserModelInfo,
)
from app.policy import resolve_agent_policy, resolve_alias, resolve_aliases_list, resolve_model_policy
from app.proxy import StreamOpenResult, proxy_chat_completion, proxy_embeddings, stream_chat_completion
from app.revocation import RevocationManager, revocation_manager
from app.usage import log_usage

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
    version="0.4.0",
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


@dataclass
class PolicyResult:
    """Result of policy enforcement — resolved model and delegation context."""
    resolved_model: str
    delegation_id: str | None = None
    # BYOK fields — populated when model resolves to a user-owned model
    user_model: UserModelInfo | None = None
    router_model: RouterModelInfo | None = None
    owner: str | None = None
    # Resolution chain fields (AI-121)
    requested_model: str | None = None
    provider_model_id: str | None = None


async def _enforce_policy(
    claims: AgentClaims, requested_model: str, request_type: str
) -> JSONResponse | PolicyResult:
    """Run policy, rate limit, and budget checks.

    Returns JSONResponse on denial, PolicyResult on success.
    PolicyResult carries the resolved model name (after alias resolution)
    and delegation_id for usage logging.
    """
    # Resolve full policy (models + limits) from DB
    async with get_db_conn() as conn:
        policy = await resolve_agent_policy(conn, agent_id=claims.sub)

    # Resolve alias before policy check
    resolved_model = resolve_alias(requested_model, policy)

    delegation_id: str | None = None

    # Delegation path: look up delegation, compute effective policy
    if claims.is_delegation:
        async with get_db_conn() as conn:
            deleg = await lookup_delegation_by_id(conn, delegation_id=claims.delegation_id)

        if deleg is None:
            raise HTTPException(
                status_code=401,
                detail=f"Delegation '{claims.delegation_id}' not found",
            )

        if deleg.revoked_at is not None:
            raise HTTPException(status_code=401, detail="Delegation revoked")

        if deleg.expires_at <= int(time.time()):
            raise HTTPException(status_code=401, detail="Delegation expired")

        effective = compute_effective_policy(policy, deleg)
        delegation_id = effective.delegation_id

        if resolved_model not in effective.allowed_models:
            try:
                async with get_db_conn() as conn:
                    await log_usage(
                        conn=conn,
                        agent_id=claims.sub,
                        model_name=resolved_model,
                        request_type=request_type,
                        status="error",
                        latency_ms=0,
                        delegation_id=delegation_id,
                        requested_model=requested_model,
                    )
            except Exception as e:
                logger.warning("usage_log_failed", error=str(e))
            raise HTTPException(
                status_code=403,
                detail=f"Model '{requested_model}' not authorized for this delegation",
            )

        # Delegation-level rate limit
        if effective.max_requests_per_minute is not None:
            async with get_db_conn() as conn:
                rl = await check_rate_limit(
                    conn, agent_id=claims.sub,
                    max_rpm=effective.max_requests_per_minute,
                    delegation_id=delegation_id,
                )
            if not rl.allowed:
                try:
                    async with get_db_conn() as conn:
                        await log_usage(
                            conn=conn, agent_id=claims.sub, model_name=resolved_model,
                            request_type=request_type, status="rate_limited",
                            latency_ms=0, delegation_id=delegation_id,
                            requested_model=requested_model,
                        )
                except Exception as e:
                    logger.warning("usage_log_failed", error=str(e))
                return JSONResponse(
                    status_code=429,
                    content={"error": {
                        "type": "rate_limited",
                        "message": f"Rate limit exceeded for delegation",
                        "delegation_id": delegation_id,
                        "limit": rl.limit, "window": "60s", "retry_after": rl.retry_after,
                    }},
                    headers={"Retry-After": str(rl.retry_after)},
                )

        # Delegation-level budget
        if effective.max_tokens_per_day is not None:
            async with get_db_conn() as conn:
                budget = await check_token_budget(
                    conn, agent_id=claims.sub,
                    max_tokens=effective.max_tokens_per_day,
                    delegation_id=delegation_id,
                )
            if not budget.allowed:
                try:
                    async with get_db_conn() as conn:
                        await log_usage(
                            conn=conn, agent_id=claims.sub, model_name=resolved_model,
                            request_type=request_type, status="budget_exceeded",
                            latency_ms=0, delegation_id=delegation_id,
                            requested_model=requested_model,
                        )
                except Exception as e:
                    logger.warning("usage_log_failed", error=str(e))
                return JSONResponse(
                    status_code=429,
                    content={"error": {
                        "type": "budget_exceeded",
                        "message": "Daily token budget exhausted for delegation",
                        "delegation_id": delegation_id,
                        "limit": budget.limit, "used": budget.tokens_used,
                        "resets_at": budget.resets_at,
                    }},
                )

        # Parent-level rate limit (includes all delegations)
        if policy.max_requests_per_minute is not None:
            async with get_db_conn() as conn:
                rl = await check_rate_limit(conn, agent_id=claims.sub, max_rpm=policy.max_requests_per_minute)
            if not rl.allowed:
                try:
                    async with get_db_conn() as conn:
                        await log_usage(
                            conn=conn, agent_id=claims.sub, model_name=resolved_model,
                            request_type=request_type, status="rate_limited",
                            latency_ms=0, delegation_id=delegation_id,
                            requested_model=requested_model,
                        )
                except Exception as e:
                    logger.warning("usage_log_failed", error=str(e))
                return JSONResponse(
                    status_code=429,
                    content={"error": {
                        "type": "rate_limited",
                        "message": f"Rate limit exceeded for agent '{claims.sub}'",
                        "limit": rl.limit, "window": "60s", "retry_after": rl.retry_after,
                    }},
                    headers={"Retry-After": str(rl.retry_after)},
                )

        # Parent-level budget (includes all delegations)
        if policy.max_tokens_per_day is not None:
            async with get_db_conn() as conn:
                budget = await check_token_budget(conn, agent_id=claims.sub, max_tokens=policy.max_tokens_per_day)
            if not budget.allowed:
                try:
                    async with get_db_conn() as conn:
                        await log_usage(
                            conn=conn, agent_id=claims.sub, model_name=resolved_model,
                            request_type=request_type, status="budget_exceeded",
                            latency_ms=0, delegation_id=delegation_id,
                            requested_model=requested_model,
                        )
                except Exception as e:
                    logger.warning("usage_log_failed", error=str(e))
                return JSONResponse(
                    status_code=429,
                    content={"error": {
                        "type": "budget_exceeded",
                        "message": f"Daily token budget exhausted for agent '{claims.sub}'",
                        "limit": budget.limit, "used": budget.tokens_used,
                        "resets_at": budget.resets_at,
                    }},
                )

        return PolicyResult(resolved_model=resolved_model, delegation_id=delegation_id, requested_model=requested_model)

    # Non-delegation (parent) path
    if resolved_model not in policy.allowed_models:
        raise HTTPException(
            status_code=403,
            detail=f"Model '{requested_model}' not authorized for agent '{claims.sub}'",
        )

    # Rate limit check
    if policy.max_requests_per_minute is not None:
        async with get_db_conn() as conn:
            rl = await check_rate_limit(conn, agent_id=claims.sub, max_rpm=policy.max_requests_per_minute)
        if not rl.allowed:
            try:
                async with get_db_conn() as conn:
                    await log_usage(
                        conn=conn,
                        agent_id=claims.sub,
                        model_name=resolved_model,
                        request_type=request_type,
                        status="rate_limited",
                        latency_ms=0,
                        requested_model=requested_model,
                    )
            except Exception as e:
                logger.warning("usage_log_failed", error=str(e))
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "type": "rate_limited",
                        "message": f"Rate limit exceeded for agent '{claims.sub}'",
                        "limit": rl.limit,
                        "window": "60s",
                        "retry_after": rl.retry_after,
                    }
                },
                headers={"Retry-After": str(rl.retry_after)},
            )

    # Token budget check
    if policy.max_tokens_per_day is not None:
        async with get_db_conn() as conn:
            budget = await check_token_budget(conn, agent_id=claims.sub, max_tokens=policy.max_tokens_per_day)
        if not budget.allowed:
            try:
                async with get_db_conn() as conn:
                    await log_usage(
                        conn=conn,
                        agent_id=claims.sub,
                        model_name=resolved_model,
                        request_type=request_type,
                        status="budget_exceeded",
                        latency_ms=0,
                        requested_model=requested_model,
                    )
            except Exception as e:
                logger.warning("usage_log_failed", error=str(e))
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "type": "budget_exceeded",
                        "message": f"Daily token budget exhausted for agent '{claims.sub}'",
                        "limit": budget.limit,
                        "used": budget.tokens_used,
                        "resets_at": budget.resets_at,
                    }
                },
            )

    return PolicyResult(resolved_model=resolved_model, requested_model=requested_model)


async def _resolve_byok(
    policy_result: PolicyResult, claims: AgentClaims, body: dict[str, Any],
    request: Request | None = None,
) -> PolicyResult:
    """Resolve BYOK model if applicable, mutating the request body for key injection.

    After alias resolution and policy check, determine if the resolved model is:
    1. A user-owned single model (BYOK) — decrypt key, inject into body, swap model name
    2. A router model — select route, decrypt route credentials, inject
    3. Neither — raise 403

    Mutates `body` in place (sets model name, api_key, api_base).
    Returns the enriched PolicyResult with owner and user_model fields.
    """
    resolved_model = policy_result.resolved_model

    # Look up agent owner (cached)
    async with get_db_conn() as conn:
        owner = await get_agent_owner(conn, claims.sub)

    if owner is None:
        raise HTTPException(status_code=403, detail=f"Agent '{claims.sub}' not found")

    policy_result.owner = owner

    # Try single user model first (BYOK path)
    async with get_db_conn() as conn:
        user_model = await resolve_user_model(conn, resolved_model, owner)

    if user_model is not None:
        _inject_byok_credentials(user_model, body, claims, resolved_model)
        policy_result.user_model = user_model
        policy_result.provider_model_id = user_model.litellm_model
        return policy_result

    # Try router model
    async with get_db_conn() as conn:
        router = await resolve_router_model(conn, resolved_model, owner)

    if router is not None:
        task_type = request.headers.get("x-task-type") if request else None
        route = select_route(router, task_type)
        if route is None:
            raise HTTPException(status_code=403, detail=f"No route available for model '{resolved_model}'")

        async with get_db_conn() as conn:
            route_creds = await resolve_route_credentials(conn, route, owner)

        if route_creds is None:
            route_key = route.get("key", "unknown")
            logger.error("route_credential_resolution_failed",
                         agent_id=claims.sub, model=resolved_model,
                         route_key=route_key, connection_id=route.get("connection_id"))
            raise HTTPException(
                status_code=403,
                detail=f"Route '{route_key}' credentials unavailable for model '{resolved_model}' — connection may have been deleted"
            )

        _inject_byok_credentials(route_creds, body, claims, resolved_model)
        policy_result.user_model = route_creds
        policy_result.router_model = router
        policy_result.provider_model_id = route_creds.litellm_model
        return policy_result

    # Try platform model (admin-managed, globally accessible — AI-123)
    async with get_db_conn() as conn:
        platform_model = await resolve_platform_model(conn, resolved_model)

    if platform_model is not None:
        _inject_byok_credentials(platform_model, body, claims, resolved_model)
        policy_result.user_model = platform_model
        policy_result.provider_model_id = platform_model.litellm_model
        return policy_result

    raise HTTPException(
        status_code=403,
        detail=f"Model '{resolved_model}' not found in user models for agent owner",
    )


def _inject_byok_credentials(
    model_info: UserModelInfo, body: dict[str, Any],
    claims: AgentClaims, resolved_model: str,
) -> None:
    """Decrypt and inject BYOK credentials into the request body."""
    settings = get_settings()
    try:
        api_key = decrypt_provider_key(
            model_info.api_key_encrypted,
            model_info.api_key_nonce,
            settings.provider_key_encryption_key,
        )
    except Exception as e:
        logger.error("provider_key_decrypt_failed", agent_id=claims.sub, model=resolved_model, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to decrypt provider key")

    body["model"] = model_info.litellm_model
    body["api_key"] = api_key
    if model_info.api_base_url:
        body["api_base"] = model_info.api_base_url


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, claims: AgentClaims = Depends(require_agent_auth)):
    """Proxy chat completion to LiteLLM after policy, rate limit, and budget checks."""
    settings = get_settings()
    body = await request.json()
    requested_model = body.get("model", "")

    result_or_denial = await _enforce_policy(claims, requested_model, "chat.completion")
    if isinstance(result_or_denial, JSONResponse):
        return result_or_denial
    policy_result: PolicyResult = result_or_denial

    # Replace model in request body with resolved name (alias → real)
    resolved_model = policy_result.resolved_model
    delegation_id = policy_result.delegation_id
    body["model"] = resolved_model

    # BYOK model resolution — may inject api_key/api_base into body
    policy_result = await _resolve_byok(policy_result, claims, body, request)

    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    # Streaming path
    if body.get("stream") is True:
        return await _handle_streaming(
            settings, body, claims, resolved_model, delegation_id,
            policy_result.owner,
            requested_model=policy_result.requested_model,
            provider_model_id=policy_result.provider_model_id,
        )

    # Non-streaming path
    owner = policy_result.owner
    start = time.monotonic()
    try:
        result = await proxy_chat_completion(
            client=_http_client,
            litellm_url=settings.litellm_url,
            litellm_master_key=settings.litellm_master_key,
            request_body=body,
        )
    except Exception as e:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        async with get_db_conn() as conn:
            await log_usage(
                conn=conn,
                agent_id=claims.sub,
                model_name=resolved_model,
                request_type="chat.completion",
                status="error",
                latency_ms=elapsed_ms,
                delegation_id=delegation_id,
                owner=owner,
                requested_model=policy_result.requested_model,
                provider_model_id=policy_result.provider_model_id,
            )
        logger.error("proxy_error", agent_id=claims.sub, model=resolved_model, error=str(e))
        raise HTTPException(status_code=502, detail="LiteLLM proxy error")
    finally:
        # Scrub BYOK key from request body — prevents key persistence in dict reference
        body.pop("api_key", None)
        body.pop("api_base", None)

    elapsed_ms = int((time.monotonic() - start) * 1000)
    status = "success" if result["status_code"] == 200 else "error"

    try:
        async with get_db_conn() as conn:
            await log_usage(
                conn=conn,
                agent_id=claims.sub,
                model_name=resolved_model,
                request_type="chat.completion",
                status=status,
                latency_ms=elapsed_ms,
                input_tokens=result["input_tokens"],
                output_tokens=result["output_tokens"],
                cost_usd=result["cost_usd"],
                delegation_id=delegation_id,
                owner=owner,
                requested_model=policy_result.requested_model,
                provider_model_id=policy_result.provider_model_id,
            )
    except Exception as e:
        logger.warning("usage_log_failed", error=str(e))

    return JSONResponse(content=result["body"], status_code=result["status_code"])


async def _handle_streaming(settings, body, claims, resolved_model, delegation_id=None, owner=None, *, requested_model=None, provider_model_id=None):
    """Handle streaming chat completion with SSE passthrough and usage capture."""

    start = time.monotonic()

    try:
        open_result: StreamOpenResult = await stream_chat_completion(
            client=_http_client,
            litellm_url=settings.litellm_url,
            litellm_master_key=settings.litellm_master_key,
            request_body=body,
        )
    except Exception as e:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        try:
            async with get_db_conn() as conn:
                await log_usage(
                    conn=conn,
                    agent_id=claims.sub,
                    model_name=resolved_model,
                    request_type="chat.completion",
                    status="error",
                    latency_ms=elapsed_ms,
                    delegation_id=delegation_id,
                    owner=owner,
                    requested_model=requested_model,
                    provider_model_id=provider_model_id,
                )
        except Exception as log_err:
            logger.warning("usage_log_failed", error=str(log_err))
        logger.error("stream_open_error", agent_id=claims.sub, model=resolved_model, error=str(e))
        raise HTTPException(status_code=502, detail="LiteLLM proxy error")
    finally:
        # Scrub BYOK key from request body
        body.pop("api_key", None)
        body.pop("api_base", None)

    # Non-2xx from LiteLLM before stream started — return upstream error body
    if open_result.error_body is not None:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        try:
            async with get_db_conn() as conn:
                await log_usage(
                    conn=conn,
                    agent_id=claims.sub,
                    model_name=resolved_model,
                    request_type="chat.completion",
                    status="error",
                    latency_ms=elapsed_ms,
                    delegation_id=delegation_id,
                    owner=owner,
                    requested_model=requested_model,
                    provider_model_id=provider_model_id,
                )
        except Exception as log_err:
            logger.warning("usage_log_failed", error=str(log_err))
        return JSONResponse(content=open_result.error_body, status_code=open_result.status_code)

    streaming_result = open_result.streaming_result
    generator = open_result.generator

    async def _stream_and_log():
        cancelled = False
        try:
            async for chunk in generator:
                yield chunk
        except anyio.get_cancelled_exc_class():
            cancelled = True
            raise
        except Exception:
            pass  # streaming_result.error is set by the proxy generator
        finally:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            if cancelled:
                status = "client_disconnect"
            elif streaming_result.error:
                status = "error"
            else:
                status = "success"
            try:
                # Shield from cancellation so the DB write completes even on client disconnect.
                # Without this, anyio cancels the DB call and usage is never logged.
                with anyio.CancelScope(shield=True):
                    async with get_db_conn() as conn:
                        await log_usage(
                            conn=conn,
                            agent_id=claims.sub,
                            model_name=resolved_model,
                            request_type="chat.completion",
                            status=status,
                            latency_ms=elapsed_ms,
                            input_tokens=streaming_result.input_tokens,
                            output_tokens=streaming_result.output_tokens,
                            cost_usd=0.0 if cancelled else streaming_result.cost_usd,
                            delegation_id=delegation_id,
                            owner=owner,
                            requested_model=requested_model,
                            provider_model_id=provider_model_id,
                        )
            except Exception as e:
                logger.warning("usage_log_failed", error=str(e))

    return StreamingResponse(
        _stream_and_log(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/embeddings")
async def embeddings(request: Request, claims: AgentClaims = Depends(require_agent_auth)):
    """Proxy embeddings to LiteLLM after policy, rate limit, and budget checks."""
    settings = get_settings()
    body = await request.json()
    requested_model = body.get("model", "")

    result_or_denial = await _enforce_policy(claims, requested_model, "embedding")
    if isinstance(result_or_denial, JSONResponse):
        return result_or_denial
    policy_result: PolicyResult = result_or_denial

    resolved_model = policy_result.resolved_model
    delegation_id = policy_result.delegation_id
    body["model"] = resolved_model

    # BYOK model resolution
    policy_result = await _resolve_byok(policy_result, claims, body, request)
    owner = policy_result.owner

    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    start = time.monotonic()
    try:
        result = await proxy_embeddings(
            client=_http_client,
            litellm_url=settings.litellm_url,
            litellm_master_key=settings.litellm_master_key,
            request_body=body,
        )
    except Exception as e:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        async with get_db_conn() as conn:
            await log_usage(
                conn=conn,
                agent_id=claims.sub,
                model_name=resolved_model,
                request_type="embedding",
                status="error",
                latency_ms=elapsed_ms,
                delegation_id=delegation_id,
                owner=owner,
                requested_model=policy_result.requested_model,
                provider_model_id=policy_result.provider_model_id,
            )
        logger.error("proxy_error", agent_id=claims.sub, model=resolved_model, error=str(e))
        raise HTTPException(status_code=502, detail="LiteLLM proxy error")
    finally:
        body.pop("api_key", None)
        body.pop("api_base", None)

    elapsed_ms = int((time.monotonic() - start) * 1000)
    status = "success" if result["status_code"] == 200 else "error"

    try:
        async with get_db_conn() as conn:
            await log_usage(
                conn=conn,
                agent_id=claims.sub,
                model_name=resolved_model,
                request_type="embedding",
                status=status,
                latency_ms=elapsed_ms,
                input_tokens=result["input_tokens"],
                output_tokens=0,
                cost_usd=result["cost_usd"],
                delegation_id=delegation_id,
                owner=owner,
                requested_model=policy_result.requested_model,
                provider_model_id=policy_result.provider_model_id,
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


# ---- Delegation endpoints ----

class DelegateRequest(BaseModel):
    child_label: str
    allowed_models: list[str]
    max_requests_per_minute: int | None = None
    max_tokens_per_day: int | None = None
    expires_at: int | None = None


@app.post("/v1/delegate")
async def create_delegation_endpoint(
    body: DelegateRequest,
    claims: AgentClaims = Depends(require_agent_auth),
):
    """Create a delegation granting a child a strict subset of the parent's permissions."""
    # Only parent tokens can create delegations
    if claims.is_delegation:
        raise HTTPException(status_code=403, detail="Delegation tokens cannot create sub-delegations")

    settings = get_settings()

    # Resolve parent policy
    async with get_db_conn() as conn:
        parent_policy = await resolve_agent_policy(conn, agent_id=claims.sub)

    # Resolve aliases in requested models
    resolved_models = resolve_aliases_list(body.allowed_models, parent_policy)

    # Validate narrowing
    violations = validate_narrowing(
        parent_policy, resolved_models, body.max_requests_per_minute, body.max_tokens_per_day,
    )
    if violations:
        raise HTTPException(
            status_code=400,
            detail={
                "type": "delegation_invalid",
                "message": "Cannot widen parent permissions",
                "violations": violations,
            },
        )

    # Create delegation record
    async with get_db_conn() as conn:
        deleg_info = await create_delegation(
            conn,
            parent_claims=claims,
            parent_policy=parent_policy,
            child_label=body.child_label,
            allowed_models=resolved_models,
            max_rpm=body.max_requests_per_minute,
            max_tpd=body.max_tokens_per_day,
            expires_at=body.expires_at,
        )

    # Request child JWT from API service
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    try:
        resp = await _http_client.post(
            f"{settings.api_service_url}/internal/delegation-token",
            headers={
                "Authorization": f"Bearer {settings.model_router_internal_service_token}",
                "Content-Type": "application/json",
            },
            json={
                "sub": claims.sub,
                "delegation_id": deleg_info["id"],
                "parent_jti": claims.jti,
                "expires_at": deleg_info["expires_at"],
            },
            timeout=10.0,
        )
    except Exception as e:
        # Clean up the pending delegation record
        try:
            async with get_db_conn() as conn:
                await conn.execute(
                    "DELETE FROM model_delegations WHERE id = $1", deleg_info["id"],
                )
        except Exception:
            pass
        logger.error("delegation_token_request_failed", error=str(e))
        raise HTTPException(status_code=502, detail="Failed to sign delegation token")

    if resp.status_code != 200:
        # Clean up the pending delegation record
        try:
            async with get_db_conn() as conn:
                await conn.execute(
                    "DELETE FROM model_delegations WHERE id = $1", deleg_info["id"],
                )
        except Exception:
            pass
        logger.error("delegation_token_sign_failed", status=resp.status_code, body=resp.text)
        raise HTTPException(status_code=502, detail="Failed to sign delegation token")

    token_result = resp.json()

    # Update child_jti on the delegation record
    async with get_db_conn() as conn:
        await update_child_jti(
            conn, delegation_id=deleg_info["id"], child_jti=token_result["jti"],
        )

    logger.info(
        "delegation_created",
        delegation_id=deleg_info["id"],
        parent_agent=claims.sub,
        child_label=body.child_label,
    )

    return {
        "token": token_result["token"],
        "delegation_id": deleg_info["id"],
        "expires_at": deleg_info["expires_at"],
    }


@app.get("/v1/delegations")
async def list_delegations_endpoint(claims: AgentClaims = Depends(require_agent_auth)):
    """List all delegations for the authenticated agent."""
    async with get_db_conn() as conn:
        delegations = await list_delegations(conn, agent_id=claims.sub)
    return {"delegations": delegations}


@app.post("/v1/delegate/{delegation_id}/revoke")
async def revoke_delegation_endpoint(
    delegation_id: str,
    claims: AgentClaims = Depends(require_agent_auth),
):
    """Revoke a specific delegation. Only the parent agent can revoke."""
    if claims.is_delegation:
        raise HTTPException(status_code=403, detail="Delegation tokens cannot revoke delegations")

    async with get_db_conn() as conn:
        deleg = await revoke_delegation(conn, delegation_id=delegation_id, agent_id=claims.sub)

    if deleg is None:
        raise HTTPException(status_code=404, detail="Delegation not found or already revoked")

    # Add child JTI to revocation set
    async with get_db_conn() as conn:
        await revocation_manager.revoke(
            conn,
            jti=deleg.child_jti,
            agent_id=claims.sub,
            expires_at=deleg.expires_at,
        )

    logger.info("delegation_revoked", delegation_id=delegation_id, child_jti=deleg.child_jti)
    return {"status": "revoked", "delegation_id": delegation_id}


# ---- Internal endpoints ----

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


class ValidateProviderRequest(BaseModel):
    provider: str
    api_key_encrypted: str  # hex-encoded
    api_key_nonce: str  # hex-encoded
    api_base_url: str | None = None


@app.post("/internal/validate-provider")
async def validate_provider(body: ValidateProviderRequest, authorization: str = Header(...)):
    """Validate a provider connection by sending a test request through LiteLLM.

    Authenticated via internal service token (same as /internal/revoke).
    Decrypts the provider key and sends a minimal request to verify the key works.
    """
    settings = get_settings()

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=403, detail="Missing Bearer token")

    token = authorization[7:]
    if not hmac.compare_digest(token, settings.model_router_internal_service_token):
        raise HTTPException(status_code=403, detail="Invalid service token")

    # Decrypt the provider key
    try:
        api_key = decrypt_provider_key(
            bytes.fromhex(body.api_key_encrypted),
            bytes.fromhex(body.api_key_nonce),
            settings.provider_key_encryption_key,
        )
    except Exception as e:
        logger.error("validate_provider_decrypt_failed", error=str(e))
        raise HTTPException(status_code=400, detail="Failed to decrypt provider key")

    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    # Validate by calling the provider's model-listing endpoint directly.
    # This proves the key is accepted without assuming access to any specific model.
    provider_endpoints: dict[str, str] = {
        "openai": "https://api.openai.com/v1/models",
        "anthropic": "https://api.anthropic.com/v1/models",
    }

    endpoint = provider_endpoints.get(body.provider)
    if endpoint is None:
        # Unknown provider — fall back to LiteLLM key_check endpoint
        # which validates the key format but may not reach the provider
        return JSONResponse(
            status_code=200,
            content={"valid": False, "error": f"Unsupported provider for validation: {body.provider}"},
        )

    # Build provider-appropriate auth headers
    if body.provider == "anthropic":
        headers: dict[str, str] = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
    else:
        headers = {"Authorization": f"Bearer {api_key}"}

    # Override base URL if custom api_base is set
    if body.api_base_url:
        endpoint = f"{body.api_base_url.rstrip('/')}/v1/models"

    try:
        resp = await _http_client.get(endpoint, headers=headers, timeout=15.0)
    except Exception as e:
        logger.error("validate_provider_request_failed", provider=body.provider, error=str(e))
        return JSONResponse(
            status_code=200,
            content={"valid": False, "error": f"Could not reach provider: {str(e)}"},
        )

    if resp.status_code == 200:
        return {"valid": True}

    # Non-200 means auth failed or provider error
    try:
        error_body = resp.json()
        if body.provider == "anthropic":
            error_msg = error_body.get("error", {}).get("message", resp.text[:500])
        else:
            error_msg = error_body.get("error", {}).get("message", resp.text[:500])
    except Exception:
        error_msg = resp.text[:500]

    return JSONResponse(
        status_code=200,
        content={"valid": False, "error": error_msg},
    )


@app.post("/internal/list-provider-models")
async def list_provider_models(body: ValidateProviderRequest, authorization: str = Header(...)):
    """List available models from a provider connection.

    Same auth and key decryption as validate-provider, but returns the model list
    with auto-detected type and capabilities per model.
    """
    settings = get_settings()

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=403, detail="Missing Bearer token")

    token = authorization[7:]
    if not hmac.compare_digest(token, settings.model_router_internal_service_token):
        raise HTTPException(status_code=403, detail="Invalid service token")

    try:
        api_key = decrypt_provider_key(
            bytes.fromhex(body.api_key_encrypted),
            bytes.fromhex(body.api_key_nonce),
            settings.provider_key_encryption_key,
        )
    except Exception as e:
        logger.error("list_provider_models_decrypt_failed", error=str(e))
        return JSONResponse(
            status_code=200,
            content={"models": [], "error": "Failed to decrypt provider key"},
        )

    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not initialized")

    provider_endpoints: dict[str, str] = {
        "openai": "https://api.openai.com/v1/models",
        "anthropic": "https://api.anthropic.com/v1/models",
    }

    endpoint = provider_endpoints.get(body.provider)
    if endpoint is None:
        return JSONResponse(
            status_code=200,
            content={"models": [], "error": f"Unsupported provider for model listing: {body.provider}"},
        )

    if body.provider == "anthropic":
        headers: dict[str, str] = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
    else:
        headers = {"Authorization": f"Bearer {api_key}"}

    if body.api_base_url:
        endpoint = f"{body.api_base_url.rstrip('/')}/v1/models"

    try:
        resp = await _http_client.get(endpoint, headers=headers, timeout=15.0)
    except Exception as e:
        logger.error("list_provider_models_request_failed", provider=body.provider, error=str(e))
        return JSONResponse(
            status_code=200,
            content={"models": [], "error": f"Could not reach provider: {str(e)}"},
        )

    if resp.status_code != 200:
        try:
            error_body = resp.json()
            error_msg = error_body.get("error", {}).get("message", resp.text[:500])
        except Exception:
            error_msg = resp.text[:500]
        return JSONResponse(
            status_code=200,
            content={"models": [], "error": error_msg},
        )

    try:
        data = resp.json()
        raw_models = data.get("data", [])
    except Exception:
        return JSONResponse(
            status_code=200,
            content={"models": [], "error": "Failed to parse provider response"},
        )

    prefix = f"{body.provider}/"
    models = []
    for m in raw_models:
        model_id = m.get("id", "")
        prefixed_id = f"{prefix}{model_id}" if not model_id.startswith(prefix) else model_id
        display_name = m.get("display_name") or model_id
        detected = detect_model_type(prefixed_id)
        models.append({
            "id": prefixed_id,
            "display_name": display_name,
            "detected_type": detected.detected_type,
            "capabilities": detected.capabilities,
        })

    models.sort(key=lambda x: x["id"])
    return {"models": models}
