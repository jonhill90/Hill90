"""Integration tests for the DB-first write pipeline."""

import pytest

pytestmark = pytest.mark.integration


class TestWritePipeline:
    async def test_write_creates_db_row_pending(self, app_client, agent_token, db_pool):
        """Writing an entry creates a DB row with sync_status='pending' initially."""
        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/pipeline-test.md",
                "content": "---\ntitle: Pipeline Test\ntype: note\n---\nBody.",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        # The entry should exist in DB
        row = await db_pool.fetchrow(
            "SELECT sync_status FROM knowledge_entries WHERE id = $1",
            data["id"],
        )
        assert row is not None
        # Should be pending or synced (synced if file write was fast)
        assert row["sync_status"] in ("pending", "synced")

    async def test_write_promotes_to_synced(self, app_client, agent_token, db_pool):
        """After successful file write, sync_status becomes 'synced'."""
        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/sync-test.md",
                "content": "---\ntitle: Sync Test\ntype: note\n---\nBody.",
            },
        )
        assert resp.status_code == 201
        entry_id = resp.json()["id"]

        # Give the pipeline a moment to complete file sync
        import asyncio
        await asyncio.sleep(0.1)

        row = await db_pool.fetchrow(
            "SELECT sync_status FROM knowledge_entries WHERE id = $1",
            entry_id,
        )
        assert row is not None
        assert row["sync_status"] == "synced"

    async def test_write_rollback_on_file_fail(self, app_client, agent_token, db_pool, test_settings, monkeypatch):
        """If file write fails, the DB row remains pending for reconciler pickup."""
        # Monkeypatch the file write to fail
        from app.services import knowledge_store

        async def failing_write(*args, **kwargs):
            raise OSError("Simulated disk failure")

        monkeypatch.setattr(knowledge_store, "atomic_file_write", failing_write)

        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/fail-test.md",
                "content": "---\ntitle: Fail Test\ntype: note\n---\nBody.",
            },
        )
        # Entry is created in DB even if file write fails
        assert resp.status_code == 201
        entry_id = resp.json()["id"]

        row = await db_pool.fetchrow(
            "SELECT sync_status FROM knowledge_entries WHERE id = $1",
            entry_id,
        )
        assert row is not None
        assert row["sync_status"] == "pending"
