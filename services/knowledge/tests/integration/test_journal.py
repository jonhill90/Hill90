"""Integration tests for journal append operations."""

from datetime import date

import pytest

pytestmark = pytest.mark.integration


class TestJournal:
    async def test_journal_appends_to_date_file(self, app_client, agent_token):
        today = date.today().isoformat()

        # First append
        resp = await app_client.post(
            "/api/v1/journal",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={"content": "First journal entry for today."},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert today in data["path"]

        # Second append to same day
        resp2 = await app_client.post(
            "/api/v1/journal",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={"content": "Second journal entry for today."},
        )
        assert resp2.status_code == 201

        # Read the journal entry — should contain both entries
        resp3 = await app_client.get(
            f"/api/v1/entries/{data['path']}",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert resp3.status_code == 200
        body = resp3.json()["content"]
        assert "First journal entry" in body
        assert "Second journal entry" in body

    async def test_journal_creates_new_date_file(self, app_client, agent_token):
        resp = await app_client.post(
            "/api/v1/journal",
            headers={"Authorization": f"Bearer {agent_token}"},
            json={"content": "New day, new journal."},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["path"].startswith("journal/")
        assert data["path"].endswith(".md")
