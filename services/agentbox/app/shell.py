"""Shell execution logic — plain functions, no MCP dependency.

This module contains the shell business logic extracted from the MCP tool layer.
Any process inside the container can import and use these functions directly.
"""

from __future__ import annotations

import json
import time

from app.config import ShellConfig
from app.events import EventEmitter
from app.policy import CommandPolicy

_policy: CommandPolicy | None = None
_emitter: EventEmitter | None = None


def configure(config: ShellConfig, emitter: EventEmitter | None = None) -> None:
    """Configure shell execution with policy and optional event emitter."""
    global _policy, _emitter
    _policy = CommandPolicy(
        allowed_binaries=config.allowed_binaries,
        denied_patterns=config.denied_patterns,
        max_timeout=config.max_timeout,
    )
    _emitter = emitter


async def execute_command(
    command: str,
    timeout: int = 30,
    *,
    command_id: str | None = None,
    work_id: str | None = None,
) -> str:
    """Execute a shell command with policy enforcement.

    Commands are validated against the agent's binary allowlist and deny patterns.
    Execution uses subprocess with shell=False for security.

    Args:
        command: The command to execute (e.g. "git status")
        timeout: Max execution time in seconds (1-300, default 30)
        command_id: Optional UUID to correlate command_start/command_complete events
        work_id: Optional UUID to correlate with parent work step

    Returns:
        JSON string with success, exit_code, stdout, stderr
    """
    if _policy is None:
        return json.dumps({"success": False, "error": "Shell tools not configured"})

    meta: dict[str, str] = {}
    if command_id:
        meta["command_id"] = command_id
    if work_id:
        meta["work_id"] = work_id

    if _emitter:
        _emitter.emit(
            type="command_start",
            tool="shell",
            input_summary=command,
            output_summary=None,
            duration_ms=None,
            success=None,
            metadata=meta or None,
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
            metadata=meta or None,
        )

    return json.dumps(result)


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
