"""Tests for tools.identity — agent identity tools."""

import json
import os

import pytest

from app.config import AgentConfig
from tools import identity


@pytest.fixture(autouse=True)
def configure_identity(tmp_path, monkeypatch):
    """Set up identity with temp SOUL.md and RULES.md files."""
    soul_content = "# Test Soul\nYou are a test agent."
    rules_content = "# Test Rules\nDo not break things."

    soul_file = tmp_path / "SOUL.md"
    rules_file = tmp_path / "RULES.md"
    soul_file.write_text(soul_content)
    rules_file.write_text(rules_content)

    # Patch the file paths that identity.configure reads
    config = AgentConfig(
        version=1,
        id="test-agent",
        name="Test Agent",
        description="A test agent",
    )

    # Directly set the module-level state
    identity._config = config
    identity._soul = soul_content
    identity._rules = rules_content


class TestGetIdentity:
    @pytest.mark.asyncio
    async def test_returns_identity(self):
        result = json.loads(await identity.get_identity())
        assert result["id"] == "test-agent"
        assert result["name"] == "Test Agent"
        assert "Test Soul" in result["soul"]
        assert "Test Rules" in result["rules"]

    @pytest.mark.asyncio
    async def test_has_all_fields(self):
        result = json.loads(await identity.get_identity())
        assert "id" in result
        assert "name" in result
        assert "description" in result
        assert "soul" in result
        assert "rules" in result
