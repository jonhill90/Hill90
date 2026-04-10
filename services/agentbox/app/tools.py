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


BROWSER_TOOL = {
    "type": "function",
    "function": {
        "name": "browser",
        "description": (
            "Control a headless Chromium browser. "
            "Actions: navigate (go to URL), screenshot (capture page), "
            "click (click element by selector), get_text (extract visible text), "
            "evaluate (run JavaScript)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["navigate", "screenshot", "click", "get_text", "evaluate"],
                    "description": "The browser action to perform",
                },
                "url": {
                    "type": "string",
                    "description": "URL to navigate to (for navigate)",
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector for the target element (for click, get_text)",
                },
                "script": {
                    "type": "string",
                    "description": "JavaScript to evaluate in the page (for evaluate)",
                },
                "full_page": {
                    "type": "boolean",
                    "description": "Capture full scrollable page (for screenshot, default true)",
                    "default": True,
                },
            },
            "required": ["action"],
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
    # browser is available when shell is enabled (chromium is pre-installed)
    if tools_config.shell.enabled:
        definitions.append(BROWSER_TOOL)
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

    if name == "browser":
        return await _execute_browser(arguments)

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


# ── Browser (Playwright chromium) ────────────────────────────────────

# Lazy singleton — launched on first use, reused across calls within a work item
_browser_context: object | None = None  # playwright BrowserContext
_browser_page: object | None = None     # playwright Page
_playwright_instance: object | None = None
_browser_last_screenshot: bytes | None = None  # cached PNG for cross-loop screenshot endpoint
_browser_last_url: str | None = None           # URL at time of last screenshot

MAX_TEXT_LENGTH = 4000
SCREENSHOT_DIR = "/workspace/screenshots"


async def _get_browser_page():
    """Get or create the singleton browser page."""
    global _playwright_instance, _browser_context, _browser_page

    if _browser_page is not None:
        return _browser_page

    import os
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)

    from playwright.async_api import async_playwright

    _playwright_instance = await async_playwright().start()
    browser = await _playwright_instance.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    )
    _browser_context = await browser.new_context(
        viewport={"width": 1280, "height": 720},
        user_agent="Hill90-Agent/1.0 (Headless Chromium)",
    )
    _browser_page = await _browser_context.new_page()
    return _browser_page


async def _capture_live_screenshot(page) -> None:
    """Capture screenshot on the browser's owning loop and cache it.

    The screenshot endpoint runs on uvicorn's event loop, which differs from
    the loop that owns the Playwright browser (created via asyncio.run() in
    the chat handler thread). Calling page.screenshot() cross-loop deadlocks.
    We cache screenshot bytes after every state-changing browser action so the
    endpoint can serve them without touching Playwright.
    """
    global _browser_last_screenshot, _browser_last_url
    try:
        _browser_last_screenshot = await page.screenshot(full_page=False)
        _browser_last_url = page.url
    except Exception:
        pass  # Non-blocking — stale screenshot is better than none


async def _execute_browser(args: dict) -> str:
    """Execute a browser action via Playwright. Returns JSON result."""
    action = args.get("action", "")

    try:
        page = await _get_browser_page()

        if action == "navigate":
            url = args.get("url", "")
            if not url:
                return json.dumps({"success": False, "error": "url is required"})
            resp = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            title = await page.title()
            await _capture_live_screenshot(page)
            return json.dumps({
                "success": True,
                "title": title,
                "url": page.url,
                "status": resp.status if resp else None,
            })

        elif action == "screenshot":
            import time
            full_page = args.get("full_page", True)
            filename = f"screenshot-{int(time.time())}.png"
            path = f"{SCREENSHOT_DIR}/{filename}"
            await page.screenshot(path=path, full_page=full_page)
            await _capture_live_screenshot(page)
            return json.dumps({
                "success": True,
                "path": path,
                "url": page.url,
            })

        elif action == "click":
            selector = args.get("selector", "")
            if not selector:
                return json.dumps({"success": False, "error": "selector is required"})
            await page.click(selector, timeout=10000)
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
            await _capture_live_screenshot(page)
            return json.dumps({
                "success": True,
                "url": page.url,
                "title": await page.title(),
            })

        elif action == "get_text":
            selector = args.get("selector", "body")
            element = page.locator(selector).first
            text = await element.inner_text(timeout=10000)
            if len(text) > MAX_TEXT_LENGTH:
                text = text[:MAX_TEXT_LENGTH] + f"\n...(truncated, {len(text)} total chars)"
            return json.dumps({"success": True, "text": text})

        elif action == "evaluate":
            script = args.get("script", "")
            if not script:
                return json.dumps({"success": False, "error": "script is required"})
            result = await page.evaluate(script)
            text = json.dumps(result, default=str)
            if len(text) > MAX_TEXT_LENGTH:
                text = text[:MAX_TEXT_LENGTH] + "...(truncated)"
            await _capture_live_screenshot(page)
            return json.dumps({"success": True, "result": text})

        else:
            return json.dumps({"success": False, "error": f"Unknown browser action: {action}"})

    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)[:300]})
