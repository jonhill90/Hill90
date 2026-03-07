"""AgentBox server — runtime entry point.

All routes (MCP tools and HTTP endpoints) are currently served via FastMCP.
The /health and /work endpoints use FastMCP custom_route (plain Starlette
handlers) and are intended to survive MCP removal in Phase 3.
"""

import logging
import os

from fastmcp import FastMCP
from starlette.responses import JSONResponse

from app.config import AgentConfig
from app.events import EventEmitter
from app.runtime import AgentRuntime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Config, events, and runtime — these define the container's runtime contract.
# Currently served via FastMCP; intended to survive MCP removal in Phase 3.

config = AgentConfig.from_file(
    os.environ.get("AGENT_CONFIG", "/etc/agentbox/agent.yml")
)

# Structured event emitter — writes JSONL to the logs volume.
# Shared by both MCP tool wrappers (tools/) and direct callers (app/).
emitter = EventEmitter(os.path.join(config.state.logs, "events.jsonl"))

# Runtime workload receiver — handles POST /work with bearer auth.
runtime = AgentRuntime(config, emitter, os.environ.get("WORK_TOKEN"))


# FastMCP server — hosts MCP tools and custom HTTP routes.
# MCP tool wrappers in tools/ delegate to app/shell.py and app/filesystem.py.
# Phase 3 replaces FastMCP with plain Starlette/uvicorn.

mcp = FastMCP(f"AgentBox-{config.id}")


# Health endpoint for Docker healthcheck.
# Mounted via FastMCP custom_route; intended to survive Phase 3 MCP removal.
@mcp.custom_route("/health", methods=["GET"])
async def health_endpoint(request):
    return JSONResponse({"status": "healthy", "agent": config.id})


# Work endpoint — runtime workload receiver.
# Mounted via FastMCP custom_route; intended to survive Phase 3 MCP removal.
@mcp.custom_route("/work", methods=["POST"])
async def work_endpoint(request):
    return await runtime.handle_work(request)


# Mount enabled tools with policy config.
# Shell and filesystem tools delegate to app/shell.py and app/filesystem.py
# respectively. The emitter is shared so both MCP wrappers and direct callers
# write to the same event log.
if config.tools.shell.enabled:
    from tools import shell  # noqa: E402

    shell.configure(config.tools.shell, emitter=emitter)
    mcp.mount(shell.server)

if config.tools.filesystem.enabled:
    from tools import filesystem  # noqa: E402

    filesystem.configure(config.tools.filesystem, emitter=emitter)
    mcp.mount(filesystem.server)


if __name__ == "__main__":
    logger.info(f"Starting AgentBox-{config.id} server...")
    logger.info(f"  Tools: shell={config.tools.shell.enabled}, "
                f"filesystem={config.tools.filesystem.enabled}")
    logger.info(f"  Runtime: /work endpoint {'enabled' if runtime._work_token else 'disabled (no WORK_TOKEN)'}")
    logger.info("  Transport: streamable-http on :8054")

    try:
        mcp.run(transport="streamable-http", host="0.0.0.0", port=8054)
    except KeyboardInterrupt:
        logger.info("AgentBox server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        raise
