"""Tests for tools.health — health check and resource stats."""

import json

import pytest

from app.config import AgentConfig
from tools import health


@pytest.fixture(autouse=True)
def configure_health():
    config = AgentConfig(
        version=1,
        id="test-agent",
        name="Test Agent",
        description="Test",
    )
    health.configure(config)


class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_returns_healthy(self):
        result = json.loads(await health.health_check())
        assert result["status"] == "healthy"
        assert result["agent"] == "test-agent"
        assert "pid" in result
        assert "resources" in result
