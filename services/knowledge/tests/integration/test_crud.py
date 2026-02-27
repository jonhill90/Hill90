"""Integration tests for CRUD entry operations."""

import pytest

pytestmark = pytest.mark.integration


class TestCreateEntry:
    async def test_create_entry(self, app_client, agent_token):
        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "plans/test-plan.md",
                "content": "---\ntitle: Test Plan\ntype: plan\n---\n# Test Plan\n\nContent here.",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["path"] == "plans/test-plan.md"
        assert data["title"] == "Test Plan"
        assert data["entry_type"] == "plan"
        assert data["sync_status"] in ("pending", "synced")

    async def test_create_entry_without_auth_returns_401(self, app_client):
        resp = await app_client.post(
            "/api/v1/entries",
            json={
                "path": "plans/test.md",
                "content": "---\ntitle: T\ntype: plan\n---\nBody.",
            },
        )
        assert resp.status_code == 401

    async def test_create_entry_path_traversal_returns_400(self, app_client, agent_token):
        resp = await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "../etc/passwd",
                "content": "---\ntitle: Evil\ntype: plan\n---\nBody.",
            },
        )
        assert resp.status_code == 400


class TestReadEntry:
    async def test_read_entry(self, app_client, agent_token):
        # Create first
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/read-test.md",
                "content": "---\ntitle: Read Test\ntype: note\n---\n# Read Test\n\nReadable content.",
            },
        )
        # Read back
        resp = await app_client.get(
            "/api/v1/entries/notes/read-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Read Test"
        assert "Readable content" in data["content"]


class TestUpdateEntry:
    async def test_update_entry(self, app_client, agent_token):
        # Create
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/update-test.md",
                "content": "---\ntitle: Original\ntype: note\n---\nOriginal body.",
            },
        )
        # Update
        resp = await app_client.put(
            "/api/v1/entries/notes/update-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "content": "---\ntitle: Updated\ntype: note\n---\nUpdated body.",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Updated"


class TestArchiveEntry:
    async def test_archive_entry(self, app_client, agent_token):
        # Create
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/archive-test.md",
                "content": "---\ntitle: Archive Me\ntype: note\n---\nBody.",
            },
        )
        # Archive (soft delete)
        resp = await app_client.delete(
            "/api/v1/entries/notes/archive-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["archived"] is True

        # Reading archived entry returns 404
        resp = await app_client.get(
            "/api/v1/entries/notes/archive-test.md",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 404


class TestCrossAgentIsolation:
    async def test_cross_agent_read_returns_404(
        self, app_client, agent_token, other_agent_token
    ):
        # Create entry as test-agent
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/secret.md",
                "content": "---\ntitle: Secret\ntype: note\n---\nAgent A's secret.",
            },
        )
        # Try to read as other-agent
        resp = await app_client.get(
            "/api/v1/entries/notes/secret.md",
            headers={"Authorization": f"Bearer {other_agent_token}"},
        )
        # Returns 404 (not 403) to avoid information leakage about other agents' entries
        assert resp.status_code == 404
