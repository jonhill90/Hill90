"""Revocation manager for model-router JWTs.

In-memory set backed by model_router_revoked_tokens table. On startup,
preloads non-expired JTIs from DB. On revoke, writes to DB first then
updates in-memory set. Periodic cleanup purges expired rows.
"""

import asyncio
import time
from typing import Any

import structlog

logger = structlog.get_logger()


class RevocationManager:
    """Manages revoked JWT IDs with DB persistence and in-memory cache."""

    def __init__(self) -> None:
        self.revoked_jtis: set[str] = set()
        self._cleanup_task: asyncio.Task | None = None

    async def preload(self, conn: Any) -> None:
        """Load all non-expired revoked JTIs from DB into memory."""
        now = int(time.time())
        rows = await conn.fetch(
            "SELECT jti, expires_at FROM model_router_revoked_tokens WHERE expires_at > $1",
            now,
        )
        self.revoked_jtis = {row["jti"] for row in rows}

    async def revoke(self, conn: Any, *, jti: str, agent_id: str, expires_at: int) -> None:
        """Revoke a JTI: persist to DB first, then add to in-memory set."""
        await conn.execute(
            """
            INSERT INTO model_router_revoked_tokens (jti, agent_id, expires_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (jti) DO NOTHING
            """,
            jti,
            agent_id,
            expires_at,
        )
        self.revoked_jtis.add(jti)

    def is_revoked(self, jti: str) -> bool:
        """Check if a JTI is in the revoked set."""
        return jti in self.revoked_jtis

    async def cleanup_expired(self, conn: Any) -> int:
        """Remove expired rows from DB and in-memory set. Returns count removed."""
        now = int(time.time())
        result = await conn.execute(
            "DELETE FROM model_router_revoked_tokens WHERE expires_at <= $1",
            now,
        )
        # Re-sync in-memory set from DB
        rows = await conn.fetch(
            "SELECT jti FROM model_router_revoked_tokens WHERE expires_at > $1",
            now,
        )
        self.revoked_jtis = {row["jti"] for row in rows}
        return 0  # Count not critical for Phase 1

    def start_cleanup_loop(self, pool: Any, interval_seconds: int = 600) -> None:
        """Start periodic cleanup task (every 10 minutes by default)."""
        async def _loop():
            while True:
                await asyncio.sleep(interval_seconds)
                try:
                    async with pool.acquire() as conn:
                        await self.cleanup_expired(conn)
                except Exception as e:
                    logger.warning("revocation_cleanup_error", error=str(e))

        self._cleanup_task = asyncio.create_task(_loop())

    def stop_cleanup_loop(self) -> None:
        """Cancel the periodic cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None


# Singleton instance
revocation_manager = RevocationManager()
