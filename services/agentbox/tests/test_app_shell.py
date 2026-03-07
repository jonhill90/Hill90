"""Tests for app.shell — extracted shell execution logic (no MCP dependency)."""

import json
import re
from unittest.mock import MagicMock

import pytest

from app.config import ShellConfig
from app import shell


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
    async def test_execute_echo(self):
        result = json.loads(await shell.execute_command("echo hello"))
        assert result["success"] is True
        assert "hello" in result["stdout"]

    @pytest.mark.asyncio
    async def test_denied_command(self):
        result = json.loads(await shell.execute_command("rm -rf /"))
        assert result["success"] is False
        assert "denied pattern" in result["error"]


class TestCheckCommand:
    @pytest.mark.asyncio
    async def test_check_allowed(self):
        result = json.loads(await shell.check_command("echo test"))
        assert result["allowed"] is True


class TestEventEmission:
    @pytest.mark.asyncio
    async def test_execute_emits_events(self):
        emitter = MagicMock()
        shell._emitter = emitter
        await shell.execute_command("echo hello")
        assert emitter.emit.call_count == 2
        start_call = emitter.emit.call_args_list[0]
        assert start_call.kwargs["type"] == "command_start"
        assert start_call.kwargs["tool"] == "shell"
        complete_call = emitter.emit.call_args_list[1]
        assert complete_call.kwargs["type"] == "command_complete"
        assert complete_call.kwargs["tool"] == "shell"
        assert complete_call.kwargs["success"] is True
        assert complete_call.kwargs["duration_ms"] is not None
        shell._emitter = None

    @pytest.mark.asyncio
    async def test_event_output_is_exit_code_and_byte_count(self):
        emitter = MagicMock()
        shell._emitter = emitter
        await shell.execute_command("echo hello")
        complete_call = emitter.emit.call_args_list[1]
        output = complete_call.kwargs["output_summary"]
        # Must match "exit N, M bytes stdout" — no actual stdout content
        assert re.match(r"^exit \d+, \d+ bytes stdout$", output)
        assert "hello" not in output
        shell._emitter = None


class TestUnconfigured:
    @pytest.mark.asyncio
    async def test_unconfigured_execute(self):
        shell._policy = None
        result = json.loads(await shell.execute_command("echo test"))
        assert result["success"] is False
        assert "not configured" in result["error"]


class TestNoFastMCPDependency:
    def test_no_fastmcp_import_shell(self):
        """app.shell must not contain any fastmcp import statements."""
        import ast
        import inspect

        import app.shell

        source = inspect.getsource(app.shell)
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not alias.name.startswith("fastmcp"), (
                        f"app.shell imports fastmcp: {alias.name}"
                    )
            elif isinstance(node, ast.ImportFrom):
                if node.module and node.module.startswith("fastmcp"):
                    raise AssertionError(
                        f"app.shell imports from fastmcp: {node.module}"
                    )
