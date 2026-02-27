"""AKM FastAPI application — Agent Knowledge Manager."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import asyncpg
import structlog
from fastapi import FastAPI, Request, Response

from app.config import Settings
from app.db.migrate import run_migrations
from app.middleware.agent_auth import AuthError, verify_agent_token
from app.routes import context, entries, health, internal, journal, search
from app.services.reconciler import reconcile

logger = structlog.get_logger()


def create_app(
    settings: Settings | None = None,
    pool: asyncpg.Pool | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application."""
    if settings is None:
        settings = Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        nonlocal pool

        # Load public key
        public_key_pem = Path(settings.public_key_path).read_bytes()
        app.state.public_key = public_key_pem
        app.state.settings = settings
        revoked: set[str] = set()
        app.state.revoked_jtis = revoked

        # Check for private key (needed for refresh endpoint)
        if Path(settings.private_key_path).exists():
            app.state.private_key = Path(settings.private_key_path).read_bytes()
        else:
            app.state.private_key = None

        # Create DB pool if not provided (tests provide their own)
        if pool is None:
            pool = await asyncpg.create_pool(
                settings.database_url, min_size=2, max_size=10
            )
        app.state.pool = pool

        # Run migrations
        await run_migrations(pool)

        # Populate revocation cache
        await _load_revoked_jtis(app)

        # Start reconciler background task
        reconciler_task = asyncio.create_task(
            _reconciler_loop(app, settings)
        )

        # Start revocation cache refresh
        revocation_task = asyncio.create_task(
            _revocation_refresh_loop(app)
        )

        logger.info("akm_started", port=settings.port)

        yield

        # Shutdown
        reconciler_task.cancel()
        revocation_task.cancel()
        try:
            await reconciler_task
        except asyncio.CancelledError:
            pass
        try:
            await revocation_task
        except asyncio.CancelledError:
            pass

        if pool:
            await pool.close()
        logger.info("akm_stopped")

    app = FastAPI(
        title="Hill90 Agent Knowledge Manager",
        version="0.1.0",
        lifespan=lifespan,
    )

    # Auth middleware
    @app.middleware("http")
    async def agent_auth_middleware(request: Request, call_next: Any) -> Response:
        # Skip auth for health, internal, and docs endpoints
        path = request.url.path
        if path in ("/health", "/docs", "/openapi.json") or path.startswith("/internal"):
            response: Response = await call_next(request)
            return response

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return Response(
                content='{"detail":"authentication required"}',
                status_code=401,
                media_type="application/json",
            )

        token = auth_header[7:]
        try:
            claims = verify_agent_token(
                token,
                app.state.public_key,
                revoked_jtis=app.state.revoked_jtis,
            )
        except AuthError:
            return Response(
                content='{"detail":"authentication failed"}',
                status_code=401,
                media_type="application/json",
            )

        request.state.agent_claims = claims
        result: Response = await call_next(request)
        return result

    # Register routes
    app.include_router(health.router)
    app.include_router(entries.router)
    app.include_router(search.router)
    app.include_router(journal.router)
    app.include_router(context.router)
    app.include_router(internal.router)

    return app


async def _load_revoked_jtis(app: FastAPI) -> None:
    """Load revoked JTIs from database into memory."""
    pool = app.state.pool
    rows = await pool.fetch(
        "SELECT jti FROM revoked_tokens WHERE expires_at > NOW()"
    )
    app.state.revoked_jtis = {row["jti"] for row in rows}
    logger.info("revocation_cache_loaded", count=len(app.state.revoked_jtis))


async def _revocation_refresh_loop(app: FastAPI) -> None:
    """Periodically refresh the revocation cache.

    Fetches only new revocations since last check to avoid loading
    the entire table every cycle. Cleans up expired rows every 10 cycles.
    """
    cycle = 0
    while True:
        await asyncio.sleep(30)
        cycle += 1
        try:
            pool = app.state.pool
            # Incremental: fetch only unexpired revoked JTIs and merge
            rows = await pool.fetch(
                "SELECT jti FROM revoked_tokens WHERE expires_at > NOW()"
            )
            app.state.revoked_jtis = {row["jti"] for row in rows}

            # Periodically clean up expired rows (every ~5 minutes)
            if cycle % 10 == 0:
                await pool.execute(
                    "DELETE FROM revoked_tokens WHERE expires_at < NOW()"
                )
        except Exception:
            logger.exception("revocation_refresh_failed")


async def _reconciler_loop(app: FastAPI, settings: Settings) -> None:
    """Run reconciler on startup and then periodically."""
    # Run once at startup
    try:
        await reconcile(app.state.pool, settings)
    except Exception:
        logger.exception("reconciler_startup_failed")

    # Then periodically
    while True:
        await asyncio.sleep(settings.reconciler_interval_seconds)
        try:
            await reconcile(app.state.pool, settings)
        except Exception:
            logger.exception("reconciler_cycle_failed")
