"""Filesystem operations — plain functions, no MCP dependency.

This module contains the filesystem business logic extracted from the MCP tool layer.
Any process inside the container can import and use these functions directly.
"""

from __future__ import annotations

import json
import os
import time

from app.config import FilesystemConfig
from app.events import EventEmitter
from app.policy import PathPolicy

_policy: PathPolicy | None = None
_emitter: EventEmitter | None = None


def configure(config: FilesystemConfig, emitter: EventEmitter | None = None) -> None:
    """Configure filesystem operations with path policy and optional event emitter."""
    global _policy, _emitter
    _policy = PathPolicy(
        allowed_paths=config.allowed_paths,
        denied_paths=config.denied_paths,
        read_only=config.read_only,
    )
    _emitter = emitter


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
        if _emitter:
            _emitter.emit(
                type="file_read", tool="filesystem", input_summary=path,
                output_summary="denied", duration_ms=0, success=False,
            )
        return json.dumps({"success": False, "error": reason})

    t0 = time.monotonic()
    try:
        with open(path) as f:
            content = f.read(1_000_000)  # 1MB limit
        duration_ms = int((time.monotonic() - t0) * 1000)
        if _emitter:
            _emitter.emit(
                type="file_read", tool="filesystem", input_summary=path,
                output_summary=f"{len(content)} bytes", duration_ms=duration_ms, success=True,
            )
        return json.dumps({"success": True, "content": content, "path": path})
    except FileNotFoundError:
        duration_ms = int((time.monotonic() - t0) * 1000)
        if _emitter:
            _emitter.emit(
                type="file_read", tool="filesystem", input_summary=path,
                output_summary="not found", duration_ms=duration_ms, success=False,
            )
        return json.dumps({"success": False, "error": f"File not found: {path}"})
    except PermissionError:
        return json.dumps({"success": False, "error": f"Permission denied: {path}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


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
        if _emitter:
            _emitter.emit(
                type="file_write", tool="filesystem", input_summary=path,
                output_summary="denied", duration_ms=0, success=False,
            )
        return json.dumps({"success": False, "error": reason})

    t0 = time.monotonic()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        duration_ms = int((time.monotonic() - t0) * 1000)
        if _emitter:
            _emitter.emit(
                type="file_write", tool="filesystem", input_summary=path,
                output_summary=f"{len(content)} bytes written", duration_ms=duration_ms, success=True,
            )
        return json.dumps({"success": True, "path": path, "bytes_written": len(content)})
    except PermissionError:
        return json.dumps({"success": False, "error": f"Permission denied: {path}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


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

    t0 = time.monotonic()
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
        duration_ms = int((time.monotonic() - t0) * 1000)
        if _emitter:
            _emitter.emit(
                type="directory_list", tool="filesystem", input_summary=path,
                output_summary=f"{len(entries)} entries", duration_ms=duration_ms, success=True,
            )
        return json.dumps({"success": True, "path": path, "entries": entries})
    except FileNotFoundError:
        return json.dumps({"success": False, "error": f"Directory not found: {path}"})
    except PermissionError:
        return json.dumps({"success": False, "error": f"Permission denied: {path}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
