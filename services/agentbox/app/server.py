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
        """Return a live Playwright screenshot as base64 PNG + current URL."""
        from app.tools import _browser_page

        if _browser_page is None:
            return JSONResponse(
                {"screenshot": None, "url": None, "error": "Browser not active"},
                status_code=404,
            )

        try:
            page = _browser_page
            png_bytes = await page.screenshot(full_page=False)
            return JSONResponse({
                "screenshot": base64.b64encode(png_bytes).decode("ascii"),
                "url": page.url,
            })
        except Exception as exc:
            logger.error("Screenshot failed: %s", exc, exc_info=True)
            return JSONResponse(
                {"screenshot": None, "url": None, "error": str(exc)[:200]},
                status_code=500,
            )

    async def terminal_ws_endpoint(websocket):
        await ws_terminal_handler(websocket, work_token)

    return Starlette(routes=[
        Route("/health", health_endpoint, methods=["GET"]),
        Route("/work", work_endpoint, methods=["POST"]),
        Route("/screenshot", screenshot_endpoint, methods=["GET"]),
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
