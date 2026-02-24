"""Tests for tools.filesystem — filesystem tools with path policy."""

import json
import os

import pytest

from app.config import FilesystemConfig
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


class TestUnconfigured:
    @pytest.mark.asyncio
    async def test_unconfigured_read(self):
        filesystem._policy = None
        result = json.loads(await filesystem.read_file("/workspace/test.txt"))
        assert result["success"] is False
        assert "not configured" in result["error"]
