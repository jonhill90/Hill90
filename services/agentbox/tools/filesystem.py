"""Filesystem MCP tool wrappers — thin delegation to app.filesystem.

This module registers MCP tools that delegate to the extracted filesystem logic
in app.filesystem. The business logic lives in app/filesystem.py; this file is
only the MCP registration layer.

Temporary — will be removed in Phase 3 of the runtime-first migration.
"""

from __future__ import annotations

from fastmcp import FastMCP

from app.config import FilesystemConfig
from app.events import EventEmitter
from app import filesystem as app_filesystem

server = FastMCP("FilesystemTools")


def configure(config: FilesystemConfig, emitter: EventEmitter | None = None) -> None:
    app_filesystem.configure(config, emitter=emitter)


@server.tool()
async def read_file(path: str) -> str:
    """Read file contents with path policy enforcement.

    Args:
        path: Absolute path to the file to read

    Returns:
        JSON string with success and content or error
    """
    return await app_filesystem.read_file(path)


@server.tool()
async def write_file(path: str, content: str) -> str:
    """Write content to a file with path policy enforcement.

    Args:
        path: Absolute path to the file to write
        content: Content to write

    Returns:
        JSON string with success status
    """
    return await app_filesystem.write_file(path, content)


@server.tool()
async def list_directory(path: str) -> str:
    """List directory contents with path policy enforcement.

    Args:
        path: Absolute path to the directory to list

    Returns:
        JSON string with entries (name, type, size)
    """
    return await app_filesystem.list_directory(path)
