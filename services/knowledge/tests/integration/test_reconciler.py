"""Integration tests for the reconciler background task."""

import pytest

pytestmark = pytest.mark.integration


class TestReconcilerPending:
    async def test_reconciler_promotes_synced(self, db_pool, test_settings):
        """Reconciler promotes pending rows to synced when file exists."""
        from app.services.reconciler import reconcile
        from pathlib import Path

        # Insert a pending row directly
        row = await db_pool.fetchrow(
            """INSERT INTO knowledge_entries
               (agent_id, path, title, entry_type, content_hash, sync_status, body)
               VALUES ($1, $2, $3, $4, $5, 'pending', $6)
               RETURNING id""",
            "test-agent",
            "notes/reconcile-test.md",
            "Reconcile Test",
            "note",
            "abc123",
            "---\ntitle: Reconcile Test\ntype: note\n---\nBody.",
        )
        entry_id = row["id"]

        # Write the file so reconciler can promote it
        data_dir = Path(test_settings.data_dir)
        file_path = data_dir / "agents" / "test-agent" / "notes" / "reconcile-test.md"
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text("---\ntitle: Reconcile Test\ntype: note\n---\nBody.")

        # Run reconciler
        await reconcile(db_pool, test_settings)

        updated = await db_pool.fetchrow(
            "SELECT sync_status FROM knowledge_entries WHERE id = $1",
            entry_id,
        )
        assert updated["sync_status"] == "synced"

    async def test_reconciler_quarantines_after_3_attempts(self, db_pool, test_settings):
        """Pending entries that fail 3 times are quarantined."""
        from app.services.reconciler import reconcile

        # Insert a pending row with no corresponding file and high retry count
        row = await db_pool.fetchrow(
            """INSERT INTO knowledge_entries
               (agent_id, path, title, entry_type, content_hash, sync_status, body, sync_attempts)
               VALUES ($1, $2, $3, $4, $5, 'pending', $6, 3)
               RETURNING id""",
            "test-agent",
            "notes/quarantine-test.md",
            "Quarantine Test",
            "note",
            "def456",
            "---\ntitle: Quarantine Test\ntype: note\n---\nBody.",
        )
        entry_id = row["id"]

        await reconcile(db_pool, test_settings)

        # Should be quarantined
        quarantine = await db_pool.fetchrow(
            "SELECT * FROM quarantine_entries WHERE entry_id = $1",
            entry_id,
        )
        assert quarantine is not None
        assert "max attempts" in quarantine["reason"].lower() or "quarantine" in quarantine["reason"].lower()


class TestReconcilerOrphans:
    async def test_reconciler_quarantines_orphan_file(self, db_pool, test_settings):
        """Files on disk without DB rows are quarantined, not deleted."""
        from app.services.reconciler import reconcile
        from pathlib import Path

        # Create a file with no DB row
        data_dir = Path(test_settings.data_dir)
        orphan_path = data_dir / "agents" / "test-agent" / "notes" / "orphan.md"
        orphan_path.parent.mkdir(parents=True, exist_ok=True)
        orphan_path.write_text("---\ntitle: Orphan\ntype: note\n---\nOrphan body.")

        await reconcile(db_pool, test_settings)

        # File must still exist (never deleted)
        assert orphan_path.exists()

        # Should have a quarantine record
        quarantine = await db_pool.fetchrow(
            "SELECT * FROM quarantine_entries WHERE path = $1 AND agent_id = $2",
            "notes/orphan.md",
            "test-agent",
        )
        assert quarantine is not None

    async def test_reconciler_never_deletes_files(self, db_pool, test_settings):
        """The reconciler never deletes any files, only quarantines."""
        from app.services.reconciler import reconcile
        from pathlib import Path

        data_dir = Path(test_settings.data_dir)
        safe_path = data_dir / "agents" / "test-agent" / "notes" / "safe-file.md"
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        safe_path.write_text("---\ntitle: Safe\ntype: note\n---\nSafe content.")

        await reconcile(db_pool, test_settings)

        # File must still exist
        assert safe_path.exists()
