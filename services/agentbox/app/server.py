"""AgentBox server — runtime-first entry point.

Serves /health and /work endpoints via plain Starlette + uvicorn.
Shell and filesystem functions remain available as direct Python imports
from app.shell and app.filesystem — no MCP protocol involvement.
"""

import logging
import os

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import shell
from app.config import AgentConfig
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

    async def health_endpoint(request):
        return JSONResponse({"status": "healthy", "agent": config.id})

    async def work_endpoint(request):
        return await runtime.handle_work(request)

    return Starlette(routes=[
        Route("/health", health_endpoint, methods=["GET"]),
        Route("/work", work_endpoint, methods=["POST"]),
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
