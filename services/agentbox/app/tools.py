"""Tool definitions and dispatcher for LLM function calling.

Builds OpenAI-compatible tool definitions from agent config and routes
tool calls to the existing shell/filesystem modules.

Shell commands prefer PTY execution (execute_command_pty) when the terminal
logger is configured, so output streams to terminal.jsonl for the live
terminal view. Falls back to plain subprocess (execute_command) otherwise.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import TYPE_CHECKING

from app import filesystem, shell
from app.config import ToolsConfig

if TYPE_CHECKING:
    from app.events import EventEmitter

logger = logging.getLogger(__name__)

SHELL_TOOL = {
    "type": "function",
    "function": {
        "name": "execute_command",
        "description": "Execute a shell command in the agent workspace. Commands are validated against the agent's binary allowlist and deny patterns.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to run (e.g. 'git status', 'ls -la /workspace')",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default 30, clamped to policy max)",
                    "default": 30,
                },
            },
            "required": ["command"],
        },
    },
}

READ_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read file contents from the workspace. Returns up to 1MB.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to read",
                },
            },
            "required": ["path"],
        },
    },
}

WRITE_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "write_file",
        "description": "Write content to a file in the workspace. Creates parent directories as needed.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to write",
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file",
                },
            },
            "required": ["path", "content"],
        },
    },
}

LIST_DIR_TOOL = {
    "type": "function",
    "function": {
        "name": "list_directory",
        "description": "List directory contents with file names, types, and sizes.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the directory to list",
                },
            },
            "required": ["path"],
        },
    },
}


def build_tool_definitions(tools_config: ToolsConfig) -> list[dict]:
    """Build the tools array for the LLM request based on agent config."""
    definitions: list[dict] = []
    if tools_config.shell.enabled:
        definitions.append(SHELL_TOOL)
    if tools_config.filesystem.enabled:
        definitions.append(READ_FILE_TOOL)
        if not tools_config.filesystem.read_only:
            definitions.append(WRITE_FILE_TOOL)
        definitions.append(LIST_DIR_TOOL)
    return definitions


async def execute_tool_call(
    name: str,
    arguments: dict,
    *,
    work_id: str | None = None,
    emitter: EventEmitter | None = None,
) -> str:
    """Dispatch a tool call to the appropriate module. Returns JSON string."""
    if name == "execute_command":
        command = arguments.get("command", "")
        timeout = arguments.get("timeout", 30)
        if not isinstance(timeout, int):
            try:
                timeout = int(timeout)
            except (TypeError, ValueError):
                timeout = 30
        command_id = str(uuid.uuid4())
        # Prefer PTY execution when terminal logger is configured —
        # streams output to terminal.jsonl for the live terminal view.
        if shell._terminal is not None:
            return await shell.execute_command_pty(
                command, timeout=timeout, command_id=command_id, work_id=work_id,
            )
        return await shell.execute_command(
            command, timeout=timeout, command_id=command_id, work_id=work_id,
        )

    if name == "read_file":
        path = arguments.get("path", "")
        return await filesystem.read_file(path)

    if name == "write_file":
        path = arguments.get("path", "")
        content = arguments.get("content", "")
        return await filesystem.write_file(path, content)

    if name == "list_directory":
        path = arguments.get("path", "")
        return await filesystem.list_directory(path)

    return json.dumps({"success": False, "error": f"Unknown tool: {name}"})
