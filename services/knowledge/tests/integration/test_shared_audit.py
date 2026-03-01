"""Integration tests for shared knowledge retrieval audit."""

import pytest

pytestmark = pytest.mark.integration

INTERNAL_TOKEN = "test-internal-token"
INTERNAL_HEADERS = {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


class TestRetrievalAudit:
    async def test_retrieval_audit_created_user(self, app_client, db_pool):
        """User search via internal admin creates an audit record."""
        # Create shared collection with content
        resp = await app_client.post(
            "/internal/admin/shared/collections",
            headers=INTERNAL_HEADERS,
            json={"name": "Audit User Col", "created_by": "user-audit", "visibility": "shared"},
        )
        cid = resp.json()["id"]
        await app_client.post(
            "/internal/admin/shared/sources",
            headers=INTERNAL_HEADERS,
            json={
                "collection_id": cid,
                "title": "Audit Source",
                "source_type": "text",
                "raw_content": "Content about blockchain for audit testing.",
                "created_by": "user-audit",
            },
        )

        # Search
        await app_client.get(
            "/internal/admin/shared/search",
            headers=INTERNAL_HEADERS,
            params={"q": "blockchain", "requester_id": "user-audit", "requester_type": "user"},
        )

        # Verify audit record
        row = await db_pool.fetchrow(
            """SELECT * FROM shared_retrievals
               WHERE requester_id = $1 AND requester_type = 'user'
               ORDER BY created_at DESC LIMIT 1""",
            "user-audit",
        )
        assert row is not None
        assert row["query"] == "blockchain"
        assert row["result_count"] >= 1

    async def test_retrieval_audit_created_agent(self, app_client, agent_token, db_pool):
        """Agent search creates an audit record with agent_owner populated."""
        # Create shared collection
        resp = await app_client.post(
            "/internal/admin/shared/collections",
            headers=INTERNAL_HEADERS,
            json={"name": "Audit Agent Col", "created_by": "test-user-sub", "visibility": "shared"},
        )
        cid = resp.json()["id"]
        await app_client.post(
            "/internal/admin/shared/sources",
            headers=INTERNAL_HEADERS,
            json={
                "collection_id": cid,
                "title": "Agent Audit Source",
                "source_type": "text",
                "raw_content": "Content about cryptography for agent audit testing.",
                "created_by": "test-user-sub",
            },
        )

        # Agent search
        await app_client.get(
            "/api/v1/shared/search",
            headers={"Authorization": f"Bearer {agent_token}"},
            params={"q": "cryptography"},
        )

        # Verify audit record
        row = await db_pool.fetchrow(
            """SELECT * FROM shared_retrievals
               WHERE requester_type = 'agent' AND requester_id = 'test-agent'
               ORDER BY created_at DESC LIMIT 1"""
        )
        assert row is not None
        assert row["query"] == "cryptography"
        assert row["agent_owner"] == "test-user-sub"
        assert row["result_count"] >= 1
        assert len(row["chunk_ids"]) >= 1
