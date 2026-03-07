"""AgentBox server — runtime entry point.

This module is organized into two sections:
1. Runtime foundation (MCP-independent) — config, events, health endpoint
2. MCP compatibility layer (temporary) — FastMCP server and tool mounting

The runtime foundation survives MCP removal (Phase 3). The MCP compatibility
layer will be replaced by plain Starlette/uvicorn in Phase 3.
"""

import logging
import os

from fastmcp import FastMCP
from starlette.responses import JSONResponse

from app.config import AgentConfig
from app.events import EventEmitter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# === Runtime foundation (MCP-independent) ===
# Config loading, event emitter, health endpoint
# These components define the container's runtime contract and are
# independent of the MCP transport layer.

config = AgentConfig.from_file(
    os.environ.get("AGENT_CONFIG", "/etc/agentbox/agent.yml")
)

# Structured event emitter — writes JSONL to the logs volume.
# Shared by both MCP tool wrappers (tools/) and direct callers (app/).
emitter = EventEmitter(os.path.join(config.state.logs, "events.jsonl"))


# === MCP compatibility layer (temporary — removed in Phase 3) ===
# FastMCP server and tool mounting. The MCP wrappers in tools/ delegate
# to business logic in app/shell.py and app/filesystem.py.

mcp = FastMCP(f"AgentBox-{config.id}")


# Health endpoint for Docker healthcheck (HTTP, not MCP).
# This endpoint is part of the runtime foundation — it will be preserved
# on a plain Starlette server when FastMCP is removed in Phase 3.
@mcp.custom_route("/health", methods=["GET"])
async def health_endpoint(request):
    return JSONResponse({"status": "healthy", "agent": config.id})


# Always mount identity tool (deprecated — removal in Phase 2)
from tools import identity  # noqa: E402

identity.configure(config, emitter=emitter)
mcp.mount(identity.server)

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

# Health tool (deprecated — removal in Phase 2)
if config.tools.health.enabled:
    from tools import health  # noqa: E402

    health.configure(config, emitter=emitter)
    mcp.mount(health.server)


if __name__ == "__main__":
    logger.info(f"Starting AgentBox-{config.id} MCP server...")
    logger.info(f"  Tools: shell={config.tools.shell.enabled}, "
                f"filesystem={config.tools.filesystem.enabled}, "
                f"health={config.tools.health.enabled}")
    logger.info("  Transport: streamable-http on :8054")

    try:
        mcp.run(transport="streamable-http", host="0.0.0.0", port=8054)
    except KeyboardInterrupt:
        logger.info("AgentBox server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        raise
