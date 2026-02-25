"""Integration tests for the health endpoint."""

import pytest

pytestmark = pytest.mark.integration


class TestHealth:
    async def test_health_returns_200(self, app_client):
        resp = await app_client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
