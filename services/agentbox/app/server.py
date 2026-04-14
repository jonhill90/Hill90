"""AgentBox server — runtime-first entry point.

Serves /health and /work endpoints via plain Starlette + uvicorn.
Shell and filesystem functions remain available as direct Python imports
from app.shell and app.filesystem — no MCP protocol involvement.
"""

import base64
import json
import logging
import os

import asyncio

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route, WebSocketRoute

from app import filesystem, shell
from app.config import AgentConfig
from app.ws_terminal import ws_terminal_handler
from app.events import EventEmitter
from app.runtime import AgentRuntime
from app.token_refresh import start_model_router_refresh_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def create_app(
    config: AgentConfig,
    emitter: EventEmitter,
    work_token: str | None,
) -> Starlette:
    """Create the Starlette ASGI application.

    Exposed as a factory for testability. The module-level __main__ block
    calls this with config loaded from agent.yml.
    """
    runtime = AgentRuntime(config, emitter, work_token)

    if config.tools.shell.enabled:
        shell.configure(config.tools.shell, emitter)

    if config.tools.filesystem.enabled:
        filesystem.configure(config.tools.filesystem, emitter)
    terminal_log_path = os.path.join(config.state.logs, "terminal.jsonl")

    async def health_endpoint(request):
        return JSONResponse({"status": "healthy", "agent": config.id})

    async def work_endpoint(request):
        return await runtime.handle_work(request)

    async def terminal_stream_endpoint(request: Request):
        """SSE endpoint that streams terminal.jsonl for live command output."""
        # Read cursor from Last-Event-ID header
        cursor = 0
        last_event_id = request.headers.get("last-event-id", "")
        if last_event_id.isdigit():
            cursor = int(last_event_id)

        async def event_generator():
            """Tail terminal.jsonl and yield SSE events."""
            try:
                # Wait for file to exist
                for _ in range(50):
                    if os.path.exists(terminal_log_path):
                        break
                    await asyncio.sleep(0.1)

                if not os.path.exists(terminal_log_path):
                    yield "event: error\ndata: terminal log not found\n\n"
                    return

                with open(terminal_log_path, "r") as f:
                    # Backfill: read existing lines past cursor
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        seq = event.get("seq", 0)
                        if seq <= cursor:
                            continue
                        event_type = event.get("type", "output")
                        yield f"id: {seq}\nevent: {event_type}\ndata: {line}\n\n"

                    # Live tail: poll for new lines
                    heartbeat_counter = 0
                    while True:
                        line = f.readline()
                        if line:
                            line = line.strip()
                            if line:
                                try:
                                    event = json.loads(line)
                                    seq = event.get("seq", 0)
                                    event_type = event.get("type", "output")
                                    yield f"id: {seq}\nevent: {event_type}\ndata: {line}\n\n"
                                    if event_type == "command_exit":
                                        yield "event: end\ndata: command finished\n\n"
                                        return
                                except json.JSONDecodeError:
                                    pass
                        else:
                            await asyncio.sleep(0.2)
                            heartbeat_counter += 1
                            if heartbeat_counter >= 150:  # ~30s
                                yield ": heartbeat\n\n"
                                heartbeat_counter = 0
            except asyncio.CancelledError:
                return

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def screenshot_endpoint(request: Request):
        """Return cached Playwright screenshot as base64 PNG + current URL.

        The browser runs on a different event loop (created via asyncio.run()
        in the chat handler thread). Calling page.screenshot() from uvicorn's
        loop deadlocks. Instead, _execute_browser caches a screenshot after
        every state-changing action, and this endpoint serves the cached bytes.
        """
        import app.tools as _tools

        if _tools._browser_last_screenshot is None:
            return JSONResponse(
                {"screenshot": None, "url": None, "error": "Browser not active"},
                status_code=404,
            )

        return JSONResponse({
            "screenshot": base64.b64encode(_tools._browser_last_screenshot).decode("ascii"),
            "url": _tools._browser_last_url,
        })

    async def browser_click_endpoint(request: Request):
        """Forward a user click into the live Playwright browser."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        x_pct = body.get("x_percent")
        y_pct = body.get("y_percent")
        if not isinstance(x_pct, (int, float)) or not isinstance(y_pct, (int, float)):
            return JSONResponse({"success": False, "error": "x_percent and y_percent required"}, status_code=400)
        result = _tools.click_browser_at_percent(float(x_pct), float(y_pct))
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def browser_element_endpoint(request: Request):
        """Get DOM element info at a coordinate (for Describe mode)."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        x_pct = body.get("x_percent")
        y_pct = body.get("y_percent")
        if not isinstance(x_pct, (int, float)) or not isinstance(y_pct, (int, float)):
            return JSONResponse({"success": False, "error": "x_percent and y_percent required"}, status_code=400)
        result = _tools.get_element_at_percent(float(x_pct), float(y_pct))
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def browser_navigate_endpoint(request: Request):
        """Navigate the browser to a URL."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        url = body.get("url")
        if not isinstance(url, str) or not url:
            return JSONResponse({"success": False, "error": "url required"}, status_code=400)
        result = _tools.navigate_browser(url)
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def browser_history_endpoint(request: Request):
        """Navigate browser history: back, forward, reload."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        action = body.get("action")
        if action not in ("back", "forward", "reload"):
            return JSONResponse({"success": False, "error": "action must be back|forward|reload"}, status_code=400)
        result = _tools.browser_history(action)
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def browser_type_endpoint(request: Request):
        """Type text into the focused element."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        text = body.get("text", "")
        if not isinstance(text, str):
            return JSONResponse({"success": False, "error": "text must be a string"}, status_code=400)
        result = _tools.type_in_browser(text)
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def browser_keypress_endpoint(request: Request):
        """Press a keyboard key (Enter, Tab, Escape, etc.)."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        key = body.get("key", "")
        if not isinstance(key, str) or not key:
            return JSONResponse({"success": False, "error": "key required"}, status_code=400)
        result = _tools.press_key_in_browser(key)
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def browser_scroll_endpoint(request: Request):
        """Scroll the browser page."""
        import app.tools as _tools
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)
        delta_x = body.get("delta_x", 0)
        delta_y = body.get("delta_y", 0)
        if not isinstance(delta_x, (int, float)) or not isinstance(delta_y, (int, float)):
            return JSONResponse({"success": False, "error": "delta_x and delta_y must be numbers"}, status_code=400)
        result = _tools.scroll_browser(float(delta_x), float(delta_y))
        status = 200 if result.get("success") else 404 if "not active" in (result.get("error") or "").lower() else 500
        return JSONResponse(result, status_code=status)

    async def files_endpoint(request: Request):
        """List files in the agent workspace directory."""
        path = request.query_params.get("path", "/home/agentuser")
        # Restrict to safe roots
        real = os.path.realpath(path)
        if not (real.startswith("/home/agentuser") or real.startswith("/workspace")):
            return JSONResponse({"error": "Path not allowed"}, status_code=403)
        try:
            entries = []
            for name in sorted(os.listdir(real)):
                full = os.path.join(real, name)
                try:
                    st = os.stat(full)
                    entries.append({
                        "name": name,
                        "type": "directory" if os.path.isdir(full) else "file",
                        "size": st.st_size,
                    })
                except OSError:
                    entries.append({"name": name, "type": "unknown", "size": 0})
            return JSONResponse({"path": path, "entries": entries})
        except FileNotFoundError:
            return JSONResponse({"error": f"Not found: {path}"}, status_code=404)
        except PermissionError:
            return JSONResponse({"error": f"Permission denied: {path}"}, status_code=403)


    async def file_read_endpoint(request: Request):
        """Read file contents from the agent workspace (max 512 KB)."""
        path = request.query_params.get("path", "")
        real = os.path.realpath(path)
        if not (real.startswith("/home/agentuser") or real.startswith("/workspace")):
            return JSONResponse({"error": "Path not allowed"}, status_code=403)
        try:
            size = os.path.getsize(real)
            if size > 512 * 1024:
                return JSONResponse({"error": f"File too large ({size} bytes, max 512 KB)"}, status_code=413)
            with open(real, "r", errors="replace") as f:
                content = f.read()
            return JSONResponse({"path": path, "content": content, "size": size})
        except IsADirectoryError:
            return JSONResponse({"error": "Path is a directory"}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": f"Not found: {path}"}, status_code=404)
        except PermissionError:
            return JSONResponse({"error": f"Permission denied: {path}"}, status_code=403)

    async def terminal_ws_endpoint(websocket):
        await ws_terminal_handler(websocket, work_token)

    return Starlette(routes=[
        Route("/health", health_endpoint, methods=["GET"]),
        Route("/work", work_endpoint, methods=["POST"]),
        Route("/files", files_endpoint, methods=["GET"]),
        Route("/file-read", file_read_endpoint, methods=["GET"]),
        Route("/screenshot", screenshot_endpoint, methods=["GET"]),
        Route("/browser/click", browser_click_endpoint, methods=["POST"]),
        Route("/browser/element", browser_element_endpoint, methods=["POST"]),
        Route("/browser/navigate", browser_navigate_endpoint, methods=["POST"]),
        Route("/browser/history", browser_history_endpoint, methods=["POST"]),
        Route("/browser/scroll", browser_scroll_endpoint, methods=["POST"]),
        Route("/browser/type", browser_type_endpoint, methods=["POST"]),
        Route("/browser/keypress", browser_keypress_endpoint, methods=["POST"]),
        Route("/terminal/stream", terminal_stream_endpoint, methods=["GET"]),
        WebSocketRoute("/terminal/ws", terminal_ws_endpoint),
    ])


if __name__ == "__main__":
    config = AgentConfig.from_file(
        os.environ.get("AGENT_CONFIG", "/etc/agentbox/agent.yml")
    )
    emitter = EventEmitter(os.path.join(config.state.logs, "events.jsonl"))
    work_token = os.environ.get("WORK_TOKEN")

    app = create_app(config, emitter, work_token)

    # Start background token refresh loops
    start_model_router_refresh_loop()

    logger.info(f"Starting AgentBox-{config.id} server...")
    logger.info(f"  Runtime: /work endpoint {'enabled' if work_token else 'disabled (no WORK_TOKEN)'}")
    logger.info("  Transport: Starlette/uvicorn on :8054")

    try:
        uvicorn.run(app, host="0.0.0.0", port=8054, log_level="info")
    except KeyboardInterrupt:
        logger.info("AgentBox server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        raise
