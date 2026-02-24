"""Tests for tools.shell — shell execution tools."""

import json

import pytest

from app.config import ShellConfig
from app.policy import CommandPolicy
from tools import shell


@pytest.fixture(autouse=True)
def configure_shell(tmp_path):
    """Configure shell with a temp workspace for local testing."""
    config = ShellConfig(
        enabled=True,
        allowed_binaries=[],  # empty = no binary filter
        denied_patterns=[r"rm\s+-rf\s+/"],
        max_timeout=10,
    )
    shell.configure(config)
    # Override the policy's default cwd for local testing
    original_execute = shell._policy.execute

    def patched_execute(command, timeout=30, cwd=str(tmp_path)):
        return original_execute(command, timeout=timeout, cwd=cwd)

    shell._policy.execute = patched_execute


class TestExecuteCommand:
    @pytest.mark.asyncio
    async def test_echo(self):
        result = json.loads(await shell.execute_command("echo hello"))
        assert result["success"] is True
        assert "hello" in result["stdout"]

    @pytest.mark.asyncio
    async def test_denied_command(self):
        result = json.loads(await shell.execute_command("rm -rf /"))
        assert result["success"] is False
        assert "denied pattern" in result["error"]

    @pytest.mark.asyncio
    async def test_nonzero_exit(self):
        result = json.loads(await shell.execute_command("false"))
        assert result["success"] is False
        assert result["exit_code"] != 0


class TestCheckCommand:
    @pytest.mark.asyncio
    async def test_allowed(self):
        result = json.loads(await shell.check_command("echo test"))
        assert result["allowed"] is True

    @pytest.mark.asyncio
    async def test_denied(self):
        result = json.loads(await shell.check_command("rm -rf /home"))
        assert result["allowed"] is False


class TestUnconfigured:
    @pytest.mark.asyncio
    async def test_unconfigured_execute(self):
        shell._policy = None
        result = json.loads(await shell.execute_command("echo test"))
        assert result["success"] is False
        assert "not configured" in result["error"]

    @pytest.mark.asyncio
    async def test_unconfigured_check(self):
        shell._policy = None
        result = json.loads(await shell.check_command("echo test"))
        assert result["allowed"] is False
