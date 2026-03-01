"""Integration tests for agent-facing shared knowledge retrieval."""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
INTERNAL_HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def _setup_shared_collection(app_client, name, owner, content):
    """Create a shared collection with ingested content."""
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=INTERNAL_HEADERS,
        json={"name": name, "created_by": owner, "visibility": "shared"},
    )
    cid = resp.json()["id"]
    await app_client.post(
        "/internal/admin/shared/sources",
        headers=INTERNAL_HEADERS,
        json={
            "collection_id": cid,
            "title": f"{name} source",
            "source_type": "text",
            "raw_content": content,
            "created_by": owner,
        },
    )
    return cid


async def _setup_private_collection(app_client, name, owner, content):
    """Create a private collection with ingested content."""
    resp = await app_client.post(
        "/internal/admin/shared/collections",
        headers=INTERNAL_HEADERS,
        json={"name": name, "created_by": owner, "visibility": "private"},
    )
    cid = resp.json()["id"]
    await app_client.post(
        "/internal/admin/shared/sources",
        headers=INTERNAL_HEADERS,
        json={
            "collection_id": cid,
            "title": f"{name} source",
            "source_type": "text",
            "raw_content": content,
            "created_by": owner,
        },
    )
    return cid


class TestAgentSharedSearch:
    async def test_agent_shared_search(self, app_client, agent_token):
        """Agent can search shared knowledge via /api/v1/shared/search."""
        await _setup_shared_collection(
            app_client, "Agent Search Col", "test-user-sub",
            "Information about distributed systems and consensus algorithms.",
        )

        resp = await app_client.get(
            "/api/v1/shared/search",
            headers={"Authorization": f"Bearer {agent_token}"},
            params={"q": "distributed systems"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] >= 1
        assert data["search_type"] == "fts"

    async def test_agent_retrieval_owner_scoped(self, app_client, agent_token, other_agent_token):
        """Agent can only see owner's private collections + shared."""
        # Private collection owned by test-user-sub (agent_token's owner)
        await _setup_private_collection(
            app_client, "Owner Private Col", "test-user-sub",
            "Private content about neural networks for owner only.",
        )

        # Agent with same owner should find it
        resp = await app_client.get(
            "/api/v1/shared/search",
            headers={"Authorization": f"Bearer {agent_token}"},
            params={"q": "neural networks"},
        )
        assert resp.status_code == 200
        assert resp.json()["count"] >= 1

        # Agent with different owner should NOT find it
        resp2 = await app_client.get(
            "/api/v1/shared/search",
            headers={"Authorization": f"Bearer {other_agent_token}"},
            params={"q": "neural networks"},
        )
        assert resp2.status_code == 200
        assert resp2.json()["count"] == 0

    async def test_agent_sees_shared_collections(self, app_client, other_agent_token):
        """Any agent can see shared collections regardless of owner."""
        await _setup_shared_collection(
            app_client, "Global Shared Col", "user-global",
            "Publicly shared content about machine learning fundamentals.",
        )

        resp = await app_client.get(
            "/api/v1/shared/search",
            headers={"Authorization": f"Bearer {other_agent_token}"},
            params={"q": "machine learning"},
        )
        assert resp.status_code == 200
        assert resp.json()["count"] >= 1


class TestAgentListCollections:
    async def test_agent_list_collections(self, app_client, agent_token):
        await _setup_shared_collection(
            app_client, "Listable Col", "test-user-sub",
            "Content for listing.",
        )

        resp = await app_client.get(
            "/api/v1/shared/collections",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        names = [c["name"] for c in resp.json()]
        assert "Listable Col" in names
