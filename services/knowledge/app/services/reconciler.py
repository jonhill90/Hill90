"""Reconciler: periodic consistency check between DB and filesystem."""

from pathlib import Path

import asyncpg
import structlog

from app.config import Settings
from app.services.knowledge_store import atomic_file_write

logger = structlog.get_logger()


async def reconcile(pool: asyncpg.Pool, settings: Settings) -> None:
    """Run one reconciliation cycle.

    1. Promote pending entries whose files exist on disk to 'synced'.
    2. Retry file writes for pending entries (up to 3 attempts).
    3. Quarantine entries that exceed max attempts.
    4. Detect orphan files (on disk but not in DB) and quarantine them.
    """
    data_dir = Path(settings.data_dir)

    async with pool.acquire() as conn:
        await _reconcile_pending(conn, data_dir)
        await _reconcile_orphans(conn, data_dir)


async def _reconcile_pending(conn: asyncpg.Connection, data_dir: Path) -> None:
    """Process pending entries: promote, retry, or quarantine."""
    pending = await conn.fetch(
        """SELECT id, agent_id, path, body, sync_attempts
           FROM knowledge_entries
           WHERE sync_status = 'pending'
           ORDER BY sync_attempts ASC, created_at ASC
           LIMIT 100"""
    )

    for row in pending:
        entry_id = row["id"]
        agent_id = row["agent_id"]
        path = row["path"]
        body = row["body"]
        attempts = row["sync_attempts"]

        file_path = data_dir / "agents" / agent_id / path

        # Check if file already exists (another process may have written it)
        if file_path.exists():
            await conn.execute(
                "UPDATE knowledge_entries SET sync_status = 'synced' WHERE id = $1",
                entry_id,
            )
            logger.info("reconciler_promoted", entry_id=str(entry_id), path=path)
            continue

        # Max attempts exceeded — quarantine
        if attempts >= 3:
            await conn.execute(
                """INSERT INTO quarantine_entries (entry_id, agent_id, path, reason, attempts)
                   VALUES ($1, $2, $3, $4, $5)""",
                entry_id,
                agent_id,
                path,
                "max attempts exceeded for file sync",
                attempts,
            )
            await conn.execute(
                "UPDATE knowledge_entries SET sync_status = 'error' WHERE id = $1",
                entry_id,
            )
            logger.warning("reconciler_quarantined", entry_id=str(entry_id), path=path)
            continue

        # Retry file write
        try:
            await atomic_file_write(file_path, body)
            await conn.execute(
                "UPDATE knowledge_entries SET sync_status = 'synced' WHERE id = $1",
                entry_id,
            )
            logger.info("reconciler_synced", entry_id=str(entry_id), path=path)
        except Exception as e:
            await conn.execute(
                "UPDATE knowledge_entries SET sync_attempts = sync_attempts + 1 WHERE id = $1",
                entry_id,
            )
            logger.warning(
                "reconciler_retry_failed",
                entry_id=str(entry_id),
                path=path,
                error=str(e),
                attempt=attempts + 1,
            )


async def _reconcile_orphans(conn: asyncpg.Connection, data_dir: Path) -> None:
    """Detect files on disk without DB rows and quarantine them (never delete).

    Uses batched DB lookups per agent to avoid N+1 queries.
    """
    agents_dir = data_dir / "agents"
    if not agents_dir.exists():
        return

    for agent_dir in agents_dir.iterdir():
        if not agent_dir.is_dir():
            continue
        agent_id = agent_dir.name

        # Collect all .md files on disk for this agent
        disk_paths = {
            str(md_file.relative_to(agent_dir))
            for md_file in agent_dir.rglob("*.md")
        }
        if not disk_paths:
            continue

        # Batch fetch all known DB paths for this agent
        db_rows = await conn.fetch(
            "SELECT path FROM knowledge_entries WHERE agent_id = $1",
            agent_id,
        )
        db_paths = {row["path"] for row in db_rows}

        # Batch fetch already-quarantined paths for this agent
        q_rows = await conn.fetch(
            "SELECT path FROM quarantine_entries WHERE agent_id = $1",
            agent_id,
        )
        quarantined_paths = {row["path"] for row in q_rows}

        # Orphans = on disk but not in DB
        orphan_paths = disk_paths - db_paths - quarantined_paths
        for rel_path in orphan_paths:
            await conn.execute(
                """INSERT INTO quarantine_entries
                   (agent_id, path, reason, attempts)
                   VALUES ($1, $2, $3, 0)""",
                agent_id,
                rel_path,
                "orphan file: exists on disk but not in database",
            )
            logger.warning(
                "reconciler_orphan_quarantined",
                agent_id=agent_id,
                path=rel_path,
            )
