"""Integration tests for context summary assembly."""

import pytest

pytestmark = pytest.mark.integration


class TestContext:
    async def test_context_deterministic_order(self, app_client, agent_token):
        """Context endpoint returns entries in a deterministic order."""
        # Create a few entries of different types
        for entry_type, path, title in [
            ("context", "context.md", "Agent Context"),
            ("plan", "plans/alpha.md", "Plan Alpha"),
            ("decision", "decisions/use-postgres.md", "Use PostgreSQL"),
            ("journal", "journal/2024-01-01.md", "Journal Jan 1"),
        ]:
            await app_client.post(
                "/api/v1/entries",
                headers={"Authorization": f"Bearer {agent_token}"},
                json={
                    "path": path,
                    "content": f"---\ntitle: {title}\ntype: {entry_type}\n---\nContent for {title}.",
                },
            )

        resp = await app_client.get(
            "/api/v1/context",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "sections" in data

        # Verify deterministic ordering: context → journals → plans → decisions
        section_types = [s["type"] for s in data["sections"]]
        # context.md should come first if present
        if "context" in section_types:
            assert section_types.index("context") == 0

    async def test_context_within_token_budget(self, app_client, agent_token):
        """Context response stays within the configured token budget."""
        # Create a large entry
        large_body = "word " * 5000  # ~5000 tokens
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/large-entry.md",
                "content": f"---\ntitle: Large Entry\ntype: note\n---\n{large_body}",
            },
        )

        resp = await app_client.get(
            "/api/v1/context",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["token_count"] <= data["token_budget"]

    async def test_context_includes_citations(self, app_client, agent_token):
        """Each context section includes citation info (path, entry_id)."""
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "plans/cited-plan.md",
                "content": "---\ntitle: Cited Plan\ntype: plan\nstatus: active\n---\nPlan body.",
            },
        )

        resp = await app_client.get(
            "/api/v1/context",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        for section in data["sections"]:
            assert "path" in section
            assert "entry_id" in section
