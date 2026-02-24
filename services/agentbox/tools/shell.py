"""Shell execution tools with policy enforcement."""

from __future__ import annotations

import json

from fastmcp import FastMCP

from app.config import ShellConfig
from app.policy import CommandPolicy

server = FastMCP("ShellTools")
_policy: CommandPolicy | None = None


def configure(config: ShellConfig) -> None:
    global _policy
    _policy = CommandPolicy(
        allowed_binaries=config.allowed_binaries,
        denied_patterns=config.denied_patterns,
        max_timeout=config.max_timeout,
    )


@server.tool()
async def execute_command(command: str, timeout: int = 30) -> str:
    """Execute a shell command with policy enforcement.

    Commands are validated against the agent's binary allowlist and deny patterns.
    Execution uses subprocess with shell=False for security.

    Args:
        command: The command to execute (e.g. "git status")
        timeout: Max execution time in seconds (1-300, default 30)

    Returns:
        JSON string with success, exit_code, stdout, stderr
    """
    if _policy is None:
        return json.dumps({"success": False, "error": "Shell tools not configured"})
    result = _policy.execute(command, timeout=timeout)
    return json.dumps(result)


@server.tool()
async def check_command(command: str) -> str:
    """Check if a command would be allowed by policy without executing it.

    Args:
        command: The command to validate

    Returns:
        JSON string with allowed (bool) and reason
    """
    if _policy is None:
        return json.dumps({"allowed": False, "reason": "Shell tools not configured"})
    allowed, reason = _policy.check(command)
    return json.dumps({"allowed": allowed, "reason": reason})
