"""Filesystem tools with path policy enforcement."""

from __future__ import annotations

import json
import os

from fastmcp import FastMCP

from app.config import FilesystemConfig
from app.policy import PathPolicy

server = FastMCP("FilesystemTools")
_policy: PathPolicy | None = None


def configure(config: FilesystemConfig) -> None:
    global _policy
    _policy = PathPolicy(
        allowed_paths=config.allowed_paths,
        denied_paths=config.denied_paths,
        read_only=config.read_only,
    )


@server.tool()
async def read_file(path: str) -> str:
    """Read file contents with path policy enforcement.

    Args:
        path: Absolute path to the file to read

    Returns:
        JSON string with success and content or error
    """
    if _policy is None:
        return json.dumps({"success": False, "error": "Filesystem tools not configured"})

    allowed, reason = _policy.check_read(path)
    if not allowed:
        return json.dumps({"success": False, "error": reason})

    try:
        with open(path) as f:
            content = f.read(1_000_000)  # 1MB limit
        return json.dumps({"success": True, "content": content, "path": path})
    except FileNotFoundError:
        return json.dumps({"success": False, "error": f"File not found: {path}"})
    except PermissionError:
        return json.dumps({"success": False, "error": f"Permission denied: {path}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@server.tool()
async def write_file(path: str, content: str) -> str:
    """Write content to a file with path policy enforcement.

    Args:
        path: Absolute path to the file to write
        content: Content to write

    Returns:
        JSON string with success status
    """
    if _policy is None:
        return json.dumps({"success": False, "error": "Filesystem tools not configured"})

    allowed, reason = _policy.check_write(path)
    if not allowed:
        return json.dumps({"success": False, "error": reason})

    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        return json.dumps({"success": True, "path": path, "bytes_written": len(content)})
    except PermissionError:
        return json.dumps({"success": False, "error": f"Permission denied: {path}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@server.tool()
async def list_directory(path: str) -> str:
    """List directory contents with path policy enforcement.

    Args:
        path: Absolute path to the directory to list

    Returns:
        JSON string with entries (name, type, size)
    """
    if _policy is None:
        return json.dumps({"success": False, "error": "Filesystem tools not configured"})

    allowed, reason = _policy.check_read(path)
    if not allowed:
        return json.dumps({"success": False, "error": reason})

    try:
        entries = []
        for entry in sorted(os.listdir(path)):
            full_path = os.path.join(path, entry)
            try:
                stat = os.stat(full_path)
                entries.append({
                    "name": entry,
                    "type": "directory" if os.path.isdir(full_path) else "file",
                    "size": stat.st_size,
                })
            except OSError:
                entries.append({"name": entry, "type": "unknown", "size": 0})
        return json.dumps({"success": True, "path": path, "entries": entries})
    except FileNotFoundError:
        return json.dumps({"success": False, "error": f"Directory not found: {path}"})
    except PermissionError:
        return json.dumps({"success": False, "error": f"Permission denied: {path}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
