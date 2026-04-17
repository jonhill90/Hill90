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
import threading
import uuid
from typing import TYPE_CHECKING

from app import filesystem, shell
from app.config import ToolsConfig

if TYPE_CHECKING:
    from app.events import EventEmitter

logger = logging.getLogger(__name__)


# ── Persistent background event loop for Playwright browser ──────────
#
# The Playwright Page is bound to the asyncio event loop on which it was
# created. Agentbox has two distinct execution contexts:
#   1. The chat handler thread, which calls tools via asyncio.run() —
#      that loop is created and destroyed per chat turn.
#   2. The uvicorn HTTP endpoints (/browser/click, /browser/element, etc.)
#      which run on uvicorn's long-lived loop.
#
# Neither of those is safe to own the browser: (1) dies between turns,
# (2) can't be reached from the chat handler thread. We solve this by
# creating a dedicated daemon thread running a forever-loop that owns
# the browser. Both contexts dispatch into this loop via
# asyncio.run_coroutine_threadsafe(), which is thread-safe and loop-safe.
_browser_loop: asyncio.AbstractEventLoop = asyncio.new_event_loop()
_browser_loop_thread = threading.Thread(
    target=_browser_loop.run_forever,
    name="agentbox-browser-loop",
    daemon=True,
)
_browser_loop_thread.start()


def _run_on_browser_loop_sync(coro, timeout: float = 15.0) -> object:
    """Dispatch a coroutine onto the persistent browser loop (thread-safe).

    Blocks the caller until the coroutine completes or timeout expires.
    Safe to call from any thread (HTTP handlers, chat handler thread, tests).
    """
    future = asyncio.run_coroutine_threadsafe(coro, _browser_loop)
    return future.result(timeout=timeout)

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


SAVE_KNOWLEDGE_TOOL = {
    "type": "function",
    "function": {
        "name": "save_knowledge",
        "description": (
            "Save a knowledge entry to your persistent memory. Entries persist across sessions "
            "and are searchable. Use this to remember important findings, decisions, plans, "
            "or notes. Path determines the type: notes/*, plans/*, decisions/*, journal/*, research/*"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Entry path (e.g. 'notes/deployment-fix.md', 'decisions/use-postgres.md', 'journal/2026-04-15.md')",
                },
                "content": {
                    "type": "string",
                    "description": "Markdown content of the knowledge entry",
                },
            },
            "required": ["path", "content"],
        },
    },
}

SEARCH_KNOWLEDGE_TOOL = {
    "type": "function",
    "function": {
        "name": "search_knowledge",
        "description": "Search your persistent knowledge entries using full-text search. Returns matching entries from your memory.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (e.g. 'deployment postgres', 'API auth fix')",
                },
            },
            "required": ["query"],
        },
    },
}


SEARCH_SHARED_KNOWLEDGE_TOOL = {
    "type": "function",
    "function": {
        "name": "search_shared_knowledge",
        "description": (
            "Search the shared knowledge library for information across all collections "
            "you have access to. Returns relevant text chunks with source citations. "
            "Use this to find documentation, research, or shared notes from the team."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (e.g. 'deployment process', 'API authentication')",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default 10, max 50)",
                    "default": 10,
                },
            },
            "required": ["query"],
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
    # knowledge tools available when AKM is configured
    import os
    if os.environ.get("AKM_TOKEN") and os.environ.get("AKM_SERVICE_URL"):
        definitions.append(SAVE_KNOWLEDGE_TOOL)
        definitions.append(SEARCH_KNOWLEDGE_TOOL)
        definitions.append(SEARCH_SHARED_KNOWLEDGE_TOOL)
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

    if name == "save_knowledge":
        return await _execute_save_knowledge(arguments)

    if name == "search_knowledge":
        return await _execute_search_knowledge(arguments)

    if name == "search_shared_knowledge":
        return await _execute_search_shared_knowledge(arguments)

    return json.dumps({"success": False, "error": f"Unknown tool: {name}"})


async def _execute_save_knowledge(args: dict) -> str:
    """Save a knowledge entry to the AKM service."""
    import os
    import httpx

    path = args.get("path", "")
    content = args.get("content", "")
    if not path or not content:
        return json.dumps({"success": False, "error": "path and content are required"})

    akm_url = os.environ.get("AKM_SERVICE_URL", "")
    akm_token = os.environ.get("AKM_TOKEN", "")
    if not akm_url or not akm_token:
        return json.dumps({"success": False, "error": "AKM not configured"})

    # AKM requires YAML frontmatter — wrap content if not already present
    if not content.startswith("---"):
        entry_type = path.split("/")[0] if "/" in path else "note"
        content = f"---\ntype: {entry_type}\n---\n{content}"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{akm_url}/api/v1/entries",
                json={"path": path, "content": content},
                headers={"Authorization": f"Bearer {akm_token}"},
            )
            if res.status_code == 201:
                return json.dumps({"success": True, "path": path, "message": "Knowledge entry saved"})
            elif res.status_code == 409:
                # Entry exists — update it
                res2 = await client.put(
                    f"{akm_url}/api/v1/entries/{path}",
                    json={"content": content},
                    headers={"Authorization": f"Bearer {akm_token}"},
                )
                if res2.status_code == 200:
                    return json.dumps({"success": True, "path": path, "message": "Knowledge entry updated"})
                return json.dumps({"success": False, "error": f"Update failed: {res2.status_code} {res2.text[:200]}"})
            else:
                return json.dumps({"success": False, "error": f"AKM returned {res.status_code}: {res.text[:200]}"})
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)[:200]})


async def _execute_search_knowledge(args: dict) -> str:
    """Search knowledge entries via the AKM service."""
    import os
    import httpx

    query = args.get("query", "")
    if not query:
        return json.dumps({"success": False, "error": "query is required"})

    akm_url = os.environ.get("AKM_SERVICE_URL", "")
    akm_token = os.environ.get("AKM_TOKEN", "")
    if not akm_url or not akm_token:
        return json.dumps({"success": False, "error": "AKM not configured"})

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(
                f"{akm_url}/api/v1/search",
                params={"q": query},
                headers={"Authorization": f"Bearer {akm_token}"},
            )
            if res.status_code == 200:
                data = res.json()
                return json.dumps({"success": True, **data})
            else:
                return json.dumps({"success": False, "error": f"Search failed: {res.status_code}"})
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)[:200]})


async def _execute_search_shared_knowledge(args: dict) -> str:
    """Search shared knowledge library via the knowledge service."""
    import os
    import httpx

    query = args.get("query", "")
    if not query:
        return json.dumps({"success": False, "error": "query is required"})

    limit = args.get("limit", 10)
    if not isinstance(limit, int):
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 10
    limit = max(1, min(limit, 50))

    akm_url = os.environ.get("AKM_SERVICE_URL", "")
    akm_token = os.environ.get("AKM_TOKEN", "")
    if not akm_url or not akm_token:
        return json.dumps({"success": False, "error": "Knowledge service not configured"})

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(
                f"{akm_url}/api/v1/shared/search",
                params={"q": query, "limit": limit},
                headers={"Authorization": f"Bearer {akm_token}"},
            )
            if res.status_code == 200:
                data = res.json()
                results = data.get("results", [])
                formatted = []
                for r in results:
                    formatted.append({
                        "content": r.get("content", ""),
                        "headline": r.get("headline", ""),
                        "source_title": r.get("source_title", ""),
                        "collection_name": r.get("collection_name", ""),
                        "rank": r.get("rank"),
                    })
                return json.dumps({
                    "success": True,
                    "query": query,
                    "count": len(formatted),
                    "results": formatted,
                })
            else:
                return json.dumps({"success": False, "error": f"Search failed: {res.status_code}"})
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)[:200]})


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
#
# All Playwright state lives on the persistent background loop
# `_browser_loop` started at module import. Any caller (chat handler
# thread or uvicorn HTTP handler) must dispatch via
# `_run_on_browser_loop_sync()`, which uses
# asyncio.run_coroutine_threadsafe to cross thread/loop boundaries.
_browser_context: object | None = None  # playwright BrowserContext
_browser_page: object | None = None     # playwright Page
_playwright_instance: object | None = None
_browser_last_screenshot: bytes | None = None  # cached PNG (populated on _browser_loop)
_browser_last_url: str | None = None           # URL captured alongside screenshot

MAX_TEXT_LENGTH = 4000
SCREENSHOT_DIR = "/workspace/screenshots"


async def _ensure_browser_page_on_loop():
    """Create Playwright objects. MUST run on _browser_loop."""
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


async def _capture_live_screenshot_on_loop() -> None:
    """Capture screenshot into module-level cache. MUST run on _browser_loop."""
    global _browser_last_screenshot, _browser_last_url
    if _browser_page is None:
        return
    try:
        _browser_last_screenshot = await _browser_page.screenshot(full_page=False)
        _browser_last_url = _browser_page.url
    except Exception:
        pass  # Non-blocking — stale screenshot is better than none


def _run_browser_op(coro_fn, timeout: float = 15.0) -> dict:
    """Run a browser coroutine on the persistent loop and return result dict.

    Ensures the browser page exists first, then dispatches the operation.
    Catches all exceptions and converts them to structured error dicts.
    """
    async def _wrapped():
        await _ensure_browser_page_on_loop()
        return await coro_fn(_browser_page)
    try:
        return _run_on_browser_loop_sync(_wrapped(), timeout=timeout)
    except Exception as exc:
        return {"success": False, "error": str(exc)[:300]}


def click_browser_at_percent(x_percent: float, y_percent: float, timeout: float = 10.0) -> dict:
    """Click the browser page at (x%, y%). Safe to call from any thread/loop."""
    async def _do_click(page):
        viewport = page.viewport_size or {"width": 1280, "height": 720}
        x = int(viewport["width"] * x_percent / 100)
        y = int(viewport["height"] * y_percent / 100)
        await page.mouse.click(x, y)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:
            pass  # Not all clicks navigate
        await _capture_live_screenshot_on_loop()
        return {"success": True, "x": x, "y": y, "url": page.url}
    return _run_browser_op(_do_click, timeout)


def get_element_at_percent(x_percent: float, y_percent: float, timeout: float = 10.0) -> dict:
    """Identify the DOM element at (x%, y%) without clicking it.

    Returns element tag, id, classes, text, bounding box for Describe mode.
    """
    async def _get_element(page):
        viewport = page.viewport_size or {"width": 1280, "height": 720}
        x = int(viewport["width"] * x_percent / 100)
        y = int(viewport["height"] * y_percent / 100)
        info = await page.evaluate(
            """([x, y]) => {
                const el = document.elementFromPoint(x, y);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return {
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    classes: Array.from(el.classList),
                    text: (el.textContent || '').trim().slice(0, 100),
                    selector: el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\\s+/).slice(0,2).join('.') : ''),
                    box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                    outerHTML: el.outerHTML.slice(0, 300),
                };
            }""",
            [x, y]
        )
        return {"success": True, "element": info, "url": page.url}
    return _run_browser_op(_get_element, timeout)


def navigate_browser(url: str, timeout: float = 35.0) -> dict:
    """Navigate the browser to a URL. Safe to call from any thread/loop."""
    async def _navigate(page):
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await _capture_live_screenshot_on_loop()
        return {
            "success": True,
            "url": page.url,
            "status": resp.status if resp else None,
            "title": await page.title(),
        }
    return _run_browser_op(_navigate, timeout)


def type_in_browser(text: str, timeout: float = 10.0) -> dict:
    """Type text into the currently focused element."""
    async def _type(page):
        await page.keyboard.type(text, delay=30)
        await _capture_live_screenshot_on_loop()
        return {"success": True, "url": page.url}
    return _run_browser_op(_type, timeout)


def press_key_in_browser(key: str, timeout: float = 5.0) -> dict:
    """Press a keyboard key (Enter, Tab, Escape, Backspace, etc.)."""
    async def _press(page):
        await page.keyboard.press(key)
        await asyncio.sleep(0.15)
        await _capture_live_screenshot_on_loop()
        return {"success": True, "url": page.url}
    return _run_browser_op(_press, timeout)


def scroll_browser(delta_x: float = 0, delta_y: float = 0, timeout: float = 5.0) -> dict:
    """Scroll the browser page by (deltaX, deltaY) pixels."""
    async def _scroll(page):
        await page.mouse.wheel(delta_x, delta_y)
        await asyncio.sleep(0.15)  # Let scroll settle before screenshot
        await _capture_live_screenshot_on_loop()
        return {"success": True, "url": page.url}
    return _run_browser_op(_scroll, timeout)


def browser_history(action: str, timeout: float = 15.0) -> dict:
    """Navigate browser history: back, forward, or reload."""
    async def _nav(page):
        if action == "back":
            await page.go_back(wait_until="domcontentloaded", timeout=10000)
        elif action == "forward":
            await page.go_forward(wait_until="domcontentloaded", timeout=10000)
        elif action == "reload":
            await page.reload(wait_until="domcontentloaded", timeout=10000)
        else:
            return {"success": False, "error": f"Unknown action: {action}"}
        await _capture_live_screenshot_on_loop()
        return {"success": True, "url": page.url, "title": await page.title()}
    return _run_browser_op(_nav, timeout)


async def _execute_browser(args: dict) -> str:
    """Execute a browser action from the LLM tool loop.

    This runs in the chat handler thread's asyncio loop. We dispatch every
    Playwright operation onto the persistent browser loop so the Page stays
    bound to a single long-lived loop across turns and HTTP endpoints.
    """
    action = args.get("action", "")

    try:
        if action == "navigate":
            url = args.get("url", "")
            if not url:
                return json.dumps({"success": False, "error": "url is required"})
            result = navigate_browser(url)
            return json.dumps(result)

        elif action == "screenshot":
            import time
            full_page = args.get("full_page", True)
            filename = f"screenshot-{int(time.time())}.png"
            path = f"{SCREENSHOT_DIR}/{filename}"

            async def _screenshot(page):
                await page.screenshot(path=path, full_page=full_page)
                await _capture_live_screenshot_on_loop()
                return {"success": True, "path": path, "url": page.url}
            return json.dumps(_run_browser_op(_screenshot))

        elif action == "click":
            selector = args.get("selector", "")
            if not selector:
                return json.dumps({"success": False, "error": "selector is required"})

            async def _click_selector(page):
                await page.click(selector, timeout=10000)
                await page.wait_for_load_state("domcontentloaded", timeout=10000)
                await _capture_live_screenshot_on_loop()
                return {"success": True, "url": page.url, "title": await page.title()}
            return json.dumps(_run_browser_op(_click_selector))

        elif action == "get_text":
            selector = args.get("selector", "body")

            async def _get_text(page):
                element = page.locator(selector).first
                text = await element.inner_text(timeout=10000)
                if len(text) > MAX_TEXT_LENGTH:
                    text = text[:MAX_TEXT_LENGTH] + f"\n...(truncated, {len(text)} total chars)"
                return {"success": True, "text": text}
            return json.dumps(_run_browser_op(_get_text))

        elif action == "evaluate":
            script = args.get("script", "")
            if not script:
                return json.dumps({"success": False, "error": "script is required"})

            async def _evaluate(page):
                result = await page.evaluate(script)
                text = json.dumps(result, default=str)
                if len(text) > MAX_TEXT_LENGTH:
                    text = text[:MAX_TEXT_LENGTH] + "...(truncated)"
                await _capture_live_screenshot_on_loop()
                return {"success": True, "result": text}
            return json.dumps(_run_browser_op(_evaluate))

        else:
            return json.dumps({"success": False, "error": f"Unknown browser action: {action}"})

    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)[:300]})
