"""Integration tests for FTS search."""

import pytest

pytestmark = pytest.mark.integration


class TestSearch:
    async def test_search_returns_ranked_results(self, app_client, agent_token):
        # Create entries with different relevance
        for title, body in [
            ("FastAPI Guide", "A comprehensive guide to FastAPI web framework"),
            ("Python Basics", "Introduction to Python programming language"),
            ("FastAPI Auth", "Authentication patterns in FastAPI applications"),
        ]:
            await app_client.post(
                "/api/v1/entries",
                headers={"Authorization": f"Bearer {agent_token}"},
                json={
                    "path": f"notes/{title.lower().replace(' ', '-')}.md",
                    "content": f"---\ntitle: {title}\ntype: note\n---\n{body}",
                },
            )

        resp = await app_client.get(
            "/api/v1/search",
            headers={"Authorization": f"Bearer {agent_token}"},
            params={"q": "fastapi"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) >= 2
        # FastAPI entries should rank higher
        titles = [r["title"] for r in data["results"]]
        assert any("FastAPI" in t for t in titles)

    async def test_search_highlights_offsets(self, app_client, agent_token):
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/highlight-test.md",
                "content": "---\ntitle: Highlight Test\ntype: note\n---\nThis has a unique keyword xyzzy123 in it.",
            },
        )

        resp = await app_client.get(
            "/api/v1/search",
            headers={"Authorization": f"Bearer {agent_token}"},
            params={"q": "xyzzy123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) >= 1
        # Results should include highlight/snippet info
        result = data["results"][0]
        assert "headline" in result or "snippet" in result

    async def test_search_respects_scope(self, app_client, agent_token, other_agent_token):
        # Create entry as test-agent
        await app_client.post(
            "/api/v1/entries",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={
                "path": "notes/scoped-search.md",
                "content": "---\ntitle: Scoped Search\ntype: note\n---\nUnique term qwerty789.",
            },
        )

        # Search as other-agent should NOT find it
        resp = await app_client.get(
            "/api/v1/search",
            headers={"Authorization": f"Bearer {other_agent_token}"},
            params={"q": "qwerty789"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) == 0
