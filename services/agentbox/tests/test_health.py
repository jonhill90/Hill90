"""Tests for tools.health — health check and resource stats."""

import json
from unittest.mock import MagicMock

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


class TestEventEmission:
    @pytest.mark.asyncio
    async def test_health_emits_event(self):
        emitter = MagicMock()
        health._emitter = emitter
        await health.health_check()
        assert emitter.emit.call_count == 1
        call = emitter.emit.call_args
        assert call.kwargs["type"] == "health_check"
        assert call.kwargs["tool"] == "health"
        assert call.kwargs["input_summary"] == "health_check"
        assert "cpu=" in call.kwargs["output_summary"]
        assert "mem=" in call.kwargs["output_summary"]
        health._emitter = None
