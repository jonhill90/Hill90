"""Tests for app.tools — tool definitions and dispatcher."""

import json
from unittest.mock import ANY, AsyncMock, patch

import pytest

from app.config import FilesystemConfig, ShellConfig, ToolsConfig
from app.tools import build_tool_definitions, execute_tool_call


class TestBuildToolDefinitions:
    def test_no_tools_when_disabled(self):
        config = ToolsConfig()
        assert build_tool_definitions(config) == []

    def test_shell_only(self):
        config = ToolsConfig(shell=ShellConfig(enabled=True))
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "execute_command" in names
        assert "tmux" in names

    def test_filesystem_only(self):
        config = ToolsConfig(filesystem=FilesystemConfig(enabled=True))
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "read_file" in names
        assert "write_file" in names
        assert "list_directory" in names
        assert "execute_command" not in names

    def test_filesystem_read_only(self):
        config = ToolsConfig(filesystem=FilesystemConfig(enabled=True, read_only=True))
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert "read_file" in names
        assert "write_file" not in names
        assert "list_directory" in names

    def test_all_tools(self):
        config = ToolsConfig(
            shell=ShellConfig(enabled=True),
            filesystem=FilesystemConfig(enabled=True),
        )
        defs = build_tool_definitions(config)
        names = [d["function"]["name"] for d in defs]
        assert len(names) == 6
        assert "execute_command" in names
        assert "read_file" in names
        assert "browser" in names
        assert "write_file" in names
        assert "list_directory" in names
        assert "tmux" in names

    def test_tool_definitions_are_valid_openai_format(self):
        config = ToolsConfig(
            shell=ShellConfig(enabled=True),
            filesystem=FilesystemConfig(enabled=True),
        )
        defs = build_tool_definitions(config)
        for d in defs:
            assert d["type"] == "function"
            func = d["function"]
            assert "name" in func
            assert "description" in func
            assert "parameters" in func
            assert func["parameters"]["type"] == "object"
            assert "required" in func["parameters"]


class TestExecuteToolCall:
    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command", new_callable=AsyncMock)
    async def test_execute_command(self, mock_exec):
        mock_exec.return_value = json.dumps({"success": True, "exit_code": 0, "stdout": "hello\n", "stderr": ""})
        result = await execute_tool_call("execute_command", {"command": "echo hello", "timeout": 10})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_exec.assert_called_once_with("echo hello", timeout=10, command_id=ANY, work_id=None)

    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command", new_callable=AsyncMock)
    async def test_execute_command_generates_command_id(self, mock_exec):
        mock_exec.return_value = json.dumps({"success": True})
        await execute_tool_call("execute_command", {"command": "ls"})
        _, kwargs = mock_exec.call_args
        # command_id should be a valid UUID string
        import uuid
        uuid.UUID(kwargs["command_id"])  # raises if not valid

    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command_pty", new_callable=AsyncMock)
    @patch("app.tools.shell._terminal", new="fake-terminal")
    async def test_prefers_pty_when_terminal_configured(self, mock_pty):
        """When terminal logger is configured, execute_command uses PTY path."""
        mock_pty.return_value = json.dumps({"success": True, "exit_code": 0, "stdout": "", "stderr": ""})
        result = await execute_tool_call("execute_command", {"command": "git status"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_pty.assert_called_once_with("git status", timeout=30, command_id=ANY, work_id=None)

    @pytest.mark.asyncio
    @patch("app.tools.filesystem.read_file", new_callable=AsyncMock)
    async def test_read_file(self, mock_read):
        mock_read.return_value = json.dumps({"success": True, "content": "data", "path": "/workspace/f.txt"})
        result = await execute_tool_call("read_file", {"path": "/workspace/f.txt"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_read.assert_called_once_with("/workspace/f.txt")

    @pytest.mark.asyncio
    @patch("app.tools.filesystem.write_file", new_callable=AsyncMock)
    async def test_write_file(self, mock_write):
        mock_write.return_value = json.dumps({"success": True, "path": "/workspace/f.txt", "bytes_written": 4})
        result = await execute_tool_call("write_file", {"path": "/workspace/f.txt", "content": "data"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_write.assert_called_once_with("/workspace/f.txt", "data")

    @pytest.mark.asyncio
    @patch("app.tools.filesystem.list_directory", new_callable=AsyncMock)
    async def test_list_directory(self, mock_list):
        mock_list.return_value = json.dumps({"success": True, "path": "/workspace", "entries": []})
        result = await execute_tool_call("list_directory", {"path": "/workspace"})
        parsed = json.loads(result)
        assert parsed["success"] is True
        mock_list.assert_called_once_with("/workspace")

    @pytest.mark.asyncio
    async def test_unknown_tool(self):
        result = await execute_tool_call("unknown_tool", {})
        parsed = json.loads(result)
        assert parsed["success"] is False
        assert "Unknown tool" in parsed["error"]

    @pytest.mark.asyncio
    @patch("app.tools.shell.execute_command", new_callable=AsyncMock)
    async def test_bad_timeout_defaults_to_30(self, mock_exec):
        mock_exec.return_value = json.dumps({"success": True})
        await execute_tool_call("execute_command", {"command": "ls", "timeout": "invalid"})
        mock_exec.assert_called_once_with("ls", timeout=30, command_id=ANY, work_id=None)
