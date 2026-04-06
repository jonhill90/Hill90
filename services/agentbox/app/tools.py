"""Tool definitions and dispatcher for LLM function calling.

Builds OpenAI-compatible tool definitions from agent config and routes
tool calls to the existing shell/filesystem modules.

Shell commands prefer PTY execution (execute_command_pty) when the terminal
logger is configured, so output streams to terminal.jsonl for the live
terminal view. Falls back to plain subprocess (execute_command) otherwise.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
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


TMUX_TOOL = {
    "type": "function",
    "function": {
        "name": "tmux",
        "description": (
            "Control tmux: create windows, split panes, switch between them, "
            "send commands to specific panes, rename windows. "
            "Actions: new_window, split (h/v), select_window, select_pane, "
            "send_keys, rename_window, list_windows."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "new_window", "split", "select_window", "select_pane",
                        "send_keys", "rename_window", "list_windows",
                    ],
                    "description": "The tmux action to perform",
                },
                "name": {
                    "type": "string",
                    "description": "Window name (for new_window, rename_window, select_window)",
                },
                "direction": {
                    "type": "string",
                    "enum": ["h", "v"],
                    "description": "Split direction: h=horizontal, v=vertical (for split)",
                },
                "target": {
                    "type": "string",
                    "description": "Target pane/window (e.g. '1', '2.1', 'build')",
                },
                "keys": {
                    "type": "string",
                    "description": "Keys to send (for send_keys)",
                },
            },
            "required": ["action"],
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
    # tmux is always available when shell is enabled
    if tools_config.shell.enabled:
        definitions.append(TMUX_TOOL)
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

    if name == "tmux":
        return await _execute_tmux(arguments)

    return json.dumps({"success": False, "error": f"Unknown tool: {name}"})


TMUX_SESSION = "agent"


async def _execute_tmux(args: dict) -> str:
    """Execute a tmux action. Returns JSON result."""
    action = args.get("action", "")
    name = args.get("name", "")
    direction = args.get("direction", "v")
    target = args.get("target", "")
    keys = args.get("keys", "")

    try:
        if action == "new_window":
            cmd = ["tmux", "new-window", "-t", TMUX_SESSION]
            if name:
                cmd.extend(["-n", name])
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

        elif action == "split":
            flag = "-h" if direction == "h" else "-v"
            cmd = ["tmux", "split-window", flag, "-t", TMUX_SESSION]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

        elif action == "select_window":
            win = target or name
            cmd = ["tmux", "select-window", "-t", f"{TMUX_SESSION}:{win}"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

        elif action == "select_pane":
            cmd = ["tmux", "select-pane", "-t", f"{TMUX_SESSION}:{target}"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

        elif action == "send_keys":
            t = f"{TMUX_SESSION}:{target}" if target else TMUX_SESSION
            cmd = ["tmux", "send-keys", "-t", t, keys, "Enter"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

        elif action == "rename_window":
            cmd = ["tmux", "rename-window", "-t", TMUX_SESSION, name]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)

        elif action == "list_windows":
            cmd = ["tmux", "list-windows", "-t", TMUX_SESSION, "-F",
                   "#{window_index}:#{window_name} #{window_active}"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            return json.dumps({"success": True, "windows": result.stdout.strip()})

        else:
            return json.dumps({"success": False, "error": f"Unknown tmux action: {action}"})

        if result.returncode != 0:
            return json.dumps({"success": False, "error": result.stderr.strip()})
        return json.dumps({"success": True, "output": result.stdout.strip()})

    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)[:200]})
