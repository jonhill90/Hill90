"""Shell execution tools with policy enforcement."""

from __future__ import annotations

import json
import time

from fastmcp import FastMCP

from app.config import ShellConfig
from app.events import EventEmitter
from app.policy import CommandPolicy

server = FastMCP("ShellTools")
_policy: CommandPolicy | None = None
_emitter: EventEmitter | None = None


def configure(config: ShellConfig, emitter: EventEmitter | None = None) -> None:
    global _policy, _emitter
    _policy = CommandPolicy(
        allowed_binaries=config.allowed_binaries,
        denied_patterns=config.denied_patterns,
        max_timeout=config.max_timeout,
    )
    _emitter = emitter


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

    if _emitter:
        _emitter.emit(
            type="command_start",
            tool="shell",
            input_summary=command,
            output_summary=None,
            duration_ms=None,
            success=None,
        )

    t0 = time.monotonic()
    result = _policy.execute(command, timeout=timeout)
    duration_ms = int((time.monotonic() - t0) * 1000)

    if _emitter:
        stdout_len = len(result.get("stdout", ""))
        _emitter.emit(
            type="command_complete",
            tool="shell",
            input_summary=command,
            output_summary=f"exit {result.get('exit_code', -1)}, {stdout_len} bytes stdout",
            duration_ms=duration_ms,
            success=result.get("success", False),
        )

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
