"""Tests for app.filesystem — extracted filesystem logic (no MCP dependency)."""

import json
import os
from unittest.mock import MagicMock

import pytest

from app.config import FilesystemConfig
from app import filesystem


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
    async def test_read_file(self, workspace):
        result = json.loads(await filesystem.read_file(str(workspace / "test.txt")))
        assert result["success"] is True
        assert result["content"] == "hello world"


class TestWriteFile:
    @pytest.mark.asyncio
    async def test_write_file(self, workspace):
        path = str(workspace / "new.txt")
        result = json.loads(await filesystem.write_file(path, "new content"))
        assert result["success"] is True
        assert os.path.exists(path)
        with open(path) as f:
            assert f.read() == "new content"


class TestListDirectory:
    @pytest.mark.asyncio
    async def test_list_directory(self, workspace):
        result = json.loads(await filesystem.list_directory(str(workspace)))
        assert result["success"] is True
        names = [e["name"] for e in result["entries"]]
        assert "test.txt" in names
        assert "subdir" in names


class TestDeniedPath:
    @pytest.mark.asyncio
    async def test_denied_read(self, workspace):
        secrets = workspace / "secrets"
        secrets.mkdir(exist_ok=True)
        (secrets / "key.pem").write_text("secret")
        result = json.loads(
            await filesystem.read_file(str(secrets / "key.pem"))
        )
        assert result["success"] is False
        assert "denied" in result["error"].lower()


class TestEventEmission:
    @pytest.mark.asyncio
    async def test_read_file_emits_event(self, workspace):
        emitter = MagicMock()
        filesystem._emitter = emitter
        await filesystem.read_file(str(workspace / "test.txt"))
        assert emitter.emit.call_count == 1
        call = emitter.emit.call_args
        assert call.kwargs["type"] == "file_read"
        assert call.kwargs["tool"] == "filesystem"
        assert call.kwargs["success"] is True
        filesystem._emitter = None

    @pytest.mark.asyncio
    async def test_event_output_is_byte_count(self, workspace):
        emitter = MagicMock()
        filesystem._emitter = emitter
        await filesystem.read_file(str(workspace / "test.txt"))
        call = emitter.emit.call_args
        output = call.kwargs["output_summary"]
        # Must be byte count only, not file contents
        assert "bytes" in output
        assert "hello world" not in output
        filesystem._emitter = None


class TestNoFastMCPDependency:
    def test_no_fastmcp_import_filesystem(self):
        """app.filesystem must not contain any fastmcp import statements."""
        import ast
        import inspect

        import app.filesystem

        source = inspect.getsource(app.filesystem)
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not alias.name.startswith("fastmcp"), (
                        f"app.filesystem imports fastmcp: {alias.name}"
                    )
            elif isinstance(node, ast.ImportFrom):
                if node.module and node.module.startswith("fastmcp"):
                    raise AssertionError(
                        f"app.filesystem imports from fastmcp: {node.module}"
                    )
