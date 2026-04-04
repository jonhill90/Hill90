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
    original_streaming = shell._policy.execute_streaming

    def patched_execute(command, timeout=30, cwd=str(tmp_path)):
        return original_execute(command, timeout=timeout, cwd=cwd)

    def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
        return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)

    shell._policy.execute = patched_execute
    shell._policy.execute_streaming = patched_streaming


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
        # With streaming: command_start + N command_output + command_complete
        assert emitter.emit.call_count >= 2
        start_call = emitter.emit.call_args_list[0]
        assert start_call.kwargs["type"] == "command_start"
        assert start_call.kwargs["tool"] == "shell"
        complete_call = emitter.emit.call_args_list[-1]
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
        complete_call = emitter.emit.call_args_list[-1]
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


class TestAllowlistSuccessPath:
    """Tests that short-name allowlist resolves correctly and commands succeed."""

    @pytest.mark.asyncio
    async def test_execute_with_short_name_allowlist(self, tmp_path):
        """SM5: Command succeeds when binary is in allowlist by short name."""
        config = ShellConfig(
            enabled=True,
            allowed_binaries=["echo"],
            denied_patterns=[],
            max_timeout=10,
        )
        shell.configure(config)
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute

        result = json.loads(await shell.execute_command("echo allowlist-ok"))
        assert result["success"] is True
        assert result["exit_code"] == 0
        assert "allowlist-ok" in result["stdout"]

    @pytest.mark.asyncio
    async def test_execute_rejected_binary_not_in_allowlist(self, tmp_path):
        """SM6: Command fails when binary is not in short-name allowlist."""
        config = ShellConfig(
            enabled=True,
            allowed_binaries=["git"],
            denied_patterns=[],
            max_timeout=10,
        )
        shell.configure(config)
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute

        result = json.loads(await shell.execute_command("echo should-fail"))
        assert result["success"] is False
        assert "not in allowlist" in result["error"]


class TestMetadataPropagation:
    """Tests for command_id / work_id metadata propagation through shell events."""

    @pytest.mark.asyncio
    async def test_execute_with_command_id_metadata(self):
        """SM1: command_id kwarg propagates to all emit calls as metadata."""
        emitter = MagicMock()
        shell._emitter = emitter
        try:
            await shell.execute_command("echo test", command_id="CID-1")
            assert emitter.emit.call_count >= 2
            for call in emitter.emit.call_args_list:
                assert call.kwargs["metadata"]["command_id"] == "CID-1"
        finally:
            shell._emitter = None

    @pytest.mark.asyncio
    async def test_execute_with_work_id_metadata(self):
        """SM2: work_id kwarg propagates to all emit calls as metadata."""
        emitter = MagicMock()
        shell._emitter = emitter
        try:
            await shell.execute_command("echo test", work_id="WID-1")
            assert emitter.emit.call_count >= 2
            for call in emitter.emit.call_args_list:
                assert call.kwargs["metadata"]["work_id"] == "WID-1"
        finally:
            shell._emitter = None


class TestStreamingExecution:
    """AI-151: Tests for execute_streaming and command_output events."""

    @pytest.mark.asyncio
    async def test_execute_streaming_emits_output_events(self, tmp_path):
        """T1: execute_streaming emits command_output events per stdout line."""
        emitter = MagicMock()
        shell._emitter = emitter

        # Also patch execute_streaming cwd
        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        try:
            result = json.loads(await shell.execute_command("printf 'line1\nline2\nline3\n'"))
            assert result["success"] is True

            # Should have: command_start, 3x command_output, command_complete
            types = [c.kwargs["type"] for c in emitter.emit.call_args_list]
            assert types[0] == "command_start"
            assert types[-1] == "command_complete"
            output_events = [c for c in emitter.emit.call_args_list if c.kwargs["type"] == "command_output"]
            assert len(output_events) == 3
            lines = [c.kwargs["output_summary"] for c in output_events]
            assert lines == ["line1", "line2", "line3"]
        finally:
            shell._emitter = None

    @pytest.mark.asyncio
    async def test_execute_streaming_returns_result(self, tmp_path):
        """T2: execute_streaming still returns final result dict."""
        emitter = MagicMock()
        shell._emitter = emitter

        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        try:
            result = json.loads(await shell.execute_command("echo streaming-ok"))
            assert result["success"] is True
            assert result["exit_code"] == 0
            assert "streaming-ok" in result["stdout"]
        finally:
            shell._emitter = None

    @pytest.mark.asyncio
    async def test_command_output_has_command_id(self, tmp_path):
        """T3: command_output events carry command_id in metadata."""
        emitter = MagicMock()
        shell._emitter = emitter

        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        try:
            await shell.execute_command("echo test", command_id="CMD-123")
            output_events = [c for c in emitter.emit.call_args_list if c.kwargs["type"] == "command_output"]
            assert len(output_events) > 0
            for event in output_events:
                assert event.kwargs["metadata"]["command_id"] == "CMD-123"
        finally:
            shell._emitter = None

    @pytest.mark.asyncio
    async def test_streaming_truncates_long_lines(self, tmp_path):
        """T4: Individual output lines are truncated to max_line_len."""
        from app.policy import CommandPolicy

        policy = CommandPolicy(allowed_binaries=[], denied_patterns=[], max_timeout=10)
        lines_received: list[str] = []
        # Generate a 10KB line
        result = policy.execute_streaming(
            "python3 -c \"print('A' * 10000)\"",
            timeout=5,
            cwd=str(tmp_path),
            on_output=lambda line: lines_received.append(line),
            max_line_len=4096,
        )
        assert result["success"] is True
        assert len(lines_received) == 1
        assert len(lines_received[0]) == 4096

    @pytest.mark.asyncio
    async def test_execute_with_both_ids(self):
        """SM3: Both command_id and work_id propagate to metadata."""
        emitter = MagicMock()
        shell._emitter = emitter
        try:
            await shell.execute_command("echo test", command_id="CID-2", work_id="WID-2")
            assert emitter.emit.call_count >= 2
            for call in emitter.emit.call_args_list:
                meta = call.kwargs["metadata"]
                assert meta["command_id"] == "CID-2"
                assert meta["work_id"] == "WID-2"
        finally:
            shell._emitter = None

    @pytest.mark.asyncio
    async def test_execute_no_kwargs_no_metadata(self):
        """SM4: No command_id/work_id kwargs results in metadata=None on start/complete (backward compat)."""
        emitter = MagicMock()
        shell._emitter = emitter
        try:
            await shell.execute_command("echo test")
            assert emitter.emit.call_count >= 2
            # Check start and complete have metadata=None
            start = emitter.emit.call_args_list[0]
            complete = emitter.emit.call_args_list[-1]
            assert start.kwargs["metadata"] is None
            assert complete.kwargs["metadata"] is None
        finally:
            shell._emitter = None
