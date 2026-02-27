"""Tests for internal admin read-only endpoints."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


VALID_FRONTMATTER = """---
title: Test Entry
type: note
tags: [test]
---
This is test content.
"""


@pytest.mark.asyncio
class TestInternalAdminAuth:
    """Service token auth for /internal/admin/* endpoints."""

    async def test_missing_service_token_returns_401(self, app_client: AsyncClient) -> None:
        resp = await app_client.get("/internal/admin/agents")
        assert resp.status_code == 401

    async def test_invalid_service_token_returns_401(self, app_client: AsyncClient) -> None:
        resp = await app_client.get(
            "/internal/admin/agents",
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert resp.status_code == 401

    async def test_valid_service_token_returns_200(self, app_client: AsyncClient) -> None:
        resp = await app_client.get(
            "/internal/admin/agents",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200


@pytest.mark.asyncio
class TestInternalAdminAgents:
    """GET /internal/admin/agents — list distinct agent_ids."""

    async def test_empty_returns_empty_list(self, app_client: AsyncClient) -> None:
        resp = await app_client.get(
            "/internal/admin/agents",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_returns_agents_with_counts(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        # Create an entry so there's something to list
        await app_client.post(
            "/api/v1/entries",
            json={"path": "notes/test.md", "content": VALID_FRONTMATTER},
            headers={"Authorization": f"Bearer {agent_token}"},
        )

        resp = await app_client.get(
            "/internal/admin/agents",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        agents = resp.json()
        assert len(agents) >= 1
        agent = next(a for a in agents if a["agent_id"] == "test-agent")
        assert agent["entry_count"] >= 1
        assert "last_updated" in agent


@pytest.mark.asyncio
class TestInternalAdminEntries:
    """GET /internal/admin/entries — list/read entries by agent_id."""

    async def test_list_requires_agent_id(self, app_client: AsyncClient) -> None:
        resp = await app_client.get(
            "/internal/admin/entries",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        # agent_id is required
        assert resp.status_code == 422

    async def test_list_entries_by_agent_id(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        # Create entry
        await app_client.post(
            "/api/v1/entries",
            json={"path": "notes/admin-test.md", "content": VALID_FRONTMATTER},
            headers={"Authorization": f"Bearer {agent_token}"},
        )

        resp = await app_client.get(
            "/internal/admin/entries",
            params={"agent_id": "test-agent"},
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        entries = resp.json()
        assert len(entries) >= 1
        assert all(e["agent_id"] == "test-agent" for e in entries)

    async def test_list_entries_filtered_by_type(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        await app_client.post(
            "/api/v1/entries",
            json={"path": "notes/typed.md", "content": VALID_FRONTMATTER},
            headers={"Authorization": f"Bearer {agent_token}"},
        )

        resp = await app_client.get(
            "/internal/admin/entries",
            params={"agent_id": "test-agent", "type": "note"},
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        entries = resp.json()
        assert all(e["entry_type"] == "note" for e in entries)

    async def test_list_entries_nonexistent_agent_returns_empty(
        self, app_client: AsyncClient
    ) -> None:
        resp = await app_client.get(
            "/internal/admin/entries",
            params={"agent_id": "nonexistent-agent"},
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_read_specific_entry(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        await app_client.post(
            "/api/v1/entries",
            json={"path": "notes/specific.md", "content": VALID_FRONTMATTER},
            headers={"Authorization": f"Bearer {agent_token}"},
        )

        resp = await app_client.get(
            "/internal/admin/entries/test-agent/notes/specific.md",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        entry = resp.json()
        assert entry["path"] == "notes/specific.md"
        assert entry["agent_id"] == "test-agent"
        assert "content" in entry

    async def test_read_nonexistent_entry_returns_404(
        self, app_client: AsyncClient
    ) -> None:
        resp = await app_client.get(
            "/internal/admin/entries/test-agent/notes/nope.md",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
class TestInternalAdminSearch:
    """GET /internal/admin/search — search entries."""

    async def test_search_with_agent_id_filter(
        self, app_client: AsyncClient, agent_token: str
    ) -> None:
        await app_client.post(
            "/api/v1/entries",
            json={
                "path": "notes/searchable.md",
                "content": "---\ntitle: Searchable\ntype: note\ntags: []\n---\nUnique searchable content here.",
            },
            headers={"Authorization": f"Bearer {agent_token}"},
        )

        resp = await app_client.get(
            "/internal/admin/search",
            params={"q": "searchable", "agent_id": "test-agent"},
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert all(r["agent_id"] == "test-agent" for r in data["results"])

    async def test_search_without_agent_id_searches_all(
        self,
        app_client: AsyncClient,
        agent_token: str,
        other_agent_token: str,
    ) -> None:
        # Create entries for two different agents
        await app_client.post(
            "/api/v1/entries",
            json={
                "path": "notes/cross1.md",
                "content": "---\ntitle: Cross1\ntype: note\ntags: []\n---\nGlobalterm in agent one.",
            },
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        await app_client.post(
            "/api/v1/entries",
            json={
                "path": "notes/cross2.md",
                "content": "---\ntitle: Cross2\ntype: note\ntags: []\n---\nGlobalterm in agent two.",
            },
            headers={"Authorization": f"Bearer {other_agent_token}"},
        )

        resp = await app_client.get(
            "/internal/admin/search",
            params={"q": "globalterm"},
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        agent_ids = {r["agent_id"] for r in data["results"]}
        assert "test-agent" in agent_ids
        assert "other-agent" in agent_ids

    async def test_search_empty_results(self, app_client: AsyncClient) -> None:
        resp = await app_client.get(
            "/internal/admin/search",
            params={"q": "xyznonexistent123"},
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    async def test_search_requires_query(self, app_client: AsyncClient) -> None:
        resp = await app_client.get(
            "/internal/admin/search",
            headers={"Authorization": "Bearer test-internal-token"},
        )
        assert resp.status_code == 422
