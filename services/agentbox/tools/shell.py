"""Shell MCP tool wrappers — thin delegation to app.shell.

This module registers MCP tools that delegate to the extracted shell logic
in app.shell. The business logic lives in app/shell.py; this file is only
the MCP registration layer.

Temporary — will be removed in Phase 3 of the runtime-first migration.
"""

from __future__ import annotations

from fastmcp import FastMCP

from app.config import ShellConfig
from app.events import EventEmitter
from app import shell as app_shell

server = FastMCP("ShellTools")


def configure(config: ShellConfig, emitter: EventEmitter | None = None) -> None:
    app_shell.configure(config, emitter=emitter)


@server.tool()
async def execute_command(command: str, timeout: int = 30) -> str:
    """Execute a shell command with policy enforcement.

    Args:
        command: The command to execute (e.g. "git status")
        timeout: Max execution time in seconds (1-300, default 30)

    Returns:
        JSON string with success, exit_code, stdout, stderr
    """
    return await app_shell.execute_command(command, timeout=timeout)


@server.tool()
async def check_command(command: str) -> str:
    """Check if a command would be allowed by policy without executing it.

    Args:
        command: The command to validate

    Returns:
        JSON string with allowed (bool) and reason
    """
    return await app_shell.check_command(command)
