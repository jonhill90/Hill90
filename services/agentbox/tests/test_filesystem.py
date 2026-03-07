"""Tests for tools.filesystem — MCP wrapper filesystem tools with path policy."""

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import FilesystemConfig
from app import filesystem as app_filesystem
from tools import filesystem


@pytest.fixture
def workspace(tmp_path):
    """Create a temporary workspace directory."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    (ws / "test.txt").write_text("hello world")
    (ws / "subdir").mkdir()
    (ws / "subdir" / "nested.txt").write_text("nested content")
    return ws


@pytest.fixture(autouse=True)
def configure_fs(workspace):
    filesystem.configure(
        FilesystemConfig(
            enabled=True,
            read_only=False,
            allowed_paths=[str(workspace)],
            denied_paths=[str(workspace / "secrets")],
        )
    )
    return workspace


class TestReadFile:
    @pytest.mark.asyncio
    async def test_read_allowed(self, workspace):
        result = json.loads(await filesystem.read_file(str(workspace / "test.txt")))
        assert result["success"] is True
        assert result["content"] == "hello world"

    @pytest.mark.asyncio
    async def test_read_denied_path(self, workspace):
        secrets = workspace / "secrets"
        secrets.mkdir(exist_ok=True)
        (secrets / "key.pem").write_text("secret")
        result = json.loads(
            await filesystem.read_file(str(secrets / "key.pem"))
        )
        assert result["success"] is False
        assert "denied" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_read_outside_allowed(self):
        result = json.loads(await filesystem.read_file("/etc/hostname"))
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_read_not_found(self, workspace):
        result = json.loads(
            await filesystem.read_file(str(workspace / "nonexistent.txt"))
        )
        assert result["success"] is False
        assert "not found" in result["error"].lower()


class TestWriteFile:
    @pytest.mark.asyncio
    async def test_write_allowed(self, workspace):
        path = str(workspace / "new.txt")
        result = json.loads(await filesystem.write_file(path, "new content"))
        assert result["success"] is True
        assert os.path.exists(path)
        with open(path) as f:
            assert f.read() == "new content"

    @pytest.mark.asyncio
    async def test_write_creates_dirs(self, workspace):
        path = str(workspace / "deep" / "nested" / "file.txt")
        result = json.loads(await filesystem.write_file(path, "deep"))
        assert result["success"] is True
        assert os.path.exists(path)

    @pytest.mark.asyncio
    async def test_write_denied_when_read_only(self, workspace):
        filesystem.configure(
            FilesystemConfig(
                enabled=True,
                read_only=True,
                allowed_paths=[str(workspace)],
            )
        )
        result = json.loads(
            await filesystem.write_file(str(workspace / "blocked.txt"), "data")
        )
        assert result["success"] is False
        assert "read-only" in result["error"].lower()


class TestListDirectory:
    @pytest.mark.asyncio
    async def test_list_allowed(self, workspace):
        result = json.loads(await filesystem.list_directory(str(workspace)))
        assert result["success"] is True
        names = [e["name"] for e in result["entries"]]
        assert "test.txt" in names
        assert "subdir" in names

    @pytest.mark.asyncio
    async def test_list_outside_allowed(self):
        result = json.loads(await filesystem.list_directory("/etc"))
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_list_not_found(self, workspace):
        result = json.loads(
            await filesystem.list_directory(str(workspace / "nope"))
        )
        assert result["success"] is False


class TestEventEmission:
    @pytest.mark.asyncio
    async def test_read_file_emits_event(self, workspace):
        emitter = MagicMock()
        app_filesystem._emitter = emitter
        await filesystem.read_file(str(workspace / "test.txt"))
        assert emitter.emit.call_count == 1
        call = emitter.emit.call_args
        assert call.kwargs["type"] == "file_read"
        assert call.kwargs["tool"] == "filesystem"
        assert call.kwargs["success"] is True
        app_filesystem._emitter = None

    @pytest.mark.asyncio
    async def test_write_file_emits_event(self, workspace):
        emitter = MagicMock()
        app_filesystem._emitter = emitter
        await filesystem.write_file(str(workspace / "evt.txt"), "content")
        assert emitter.emit.call_count == 1
        call = emitter.emit.call_args
        assert call.kwargs["type"] == "file_write"
        assert call.kwargs["tool"] == "filesystem"
        app_filesystem._emitter = None

    @pytest.mark.asyncio
    async def test_filesystem_event_output_is_byte_count(self, workspace):
        emitter = MagicMock()
        app_filesystem._emitter = emitter
        await filesystem.read_file(str(workspace / "test.txt"))
        call = emitter.emit.call_args
        output = call.kwargs["output_summary"]
        # Must be byte count only, not file contents
        assert "bytes" in output
        assert "hello world" not in output
        app_filesystem._emitter = None


class TestUnconfigured:
    @pytest.mark.asyncio
    async def test_unconfigured_read(self):
        app_filesystem._policy = None
        result = json.loads(await filesystem.read_file("/workspace/test.txt"))
        assert result["success"] is False
        assert "not configured" in result["error"]


class TestMCPDelegation:
    @pytest.mark.asyncio
    async def test_mcp_wrapper_delegates(self):
        """MCP wrapper tools.filesystem.read_file delegates to app.filesystem.read_file."""
        with patch("app.filesystem.read_file", new_callable=AsyncMock) as mock_read:
            mock_read.return_value = '{"success": true, "content": "test"}'
            result = await filesystem.read_file("/workspace/test.txt")
            mock_read.assert_called_once_with("/workspace/test.txt")
            assert result == '{"success": true, "content": "test"}'
