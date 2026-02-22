"""AgentBox MCP Server — FastMCP entry point."""

import logging
import os

from fastmcp import FastMCP
from starlette.responses import JSONResponse

from app.config import AgentConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

config = AgentConfig.from_file(
    os.environ.get("AGENT_CONFIG", "/etc/agentbox/agent.yml")
)

mcp = FastMCP(f"AgentBox-{config.id}", host="0.0.0.0", port=8054)


# Health endpoint for Docker healthcheck (HTTP, not MCP)
@mcp.custom_route("/health", methods=["GET"])
async def health_endpoint(request):
    return JSONResponse({"status": "healthy", "agent": config.id})


# Always mount identity tool
from tools import identity  # noqa: E402

identity.configure(config)
mcp.mount(identity.server)

# Mount enabled tools with policy config
if config.tools.shell.enabled:
    from tools import shell  # noqa: E402

    shell.configure(config.tools.shell)
    mcp.mount(shell.server)

if config.tools.filesystem.enabled:
    from tools import filesystem  # noqa: E402

    filesystem.configure(config.tools.filesystem)
    mcp.mount(filesystem.server)

if config.tools.health.enabled:
    from tools import health  # noqa: E402

    health.configure(config)
    mcp.mount(health.server)


if __name__ == "__main__":
    logger.info(f"Starting AgentBox-{config.id} MCP server...")
    logger.info(f"  Tools: shell={config.tools.shell.enabled}, "
                f"filesystem={config.tools.filesystem.enabled}, "
                f"health={config.tools.health.enabled}")
    logger.info("  Transport: streamable-http on :8054")

    try:
        mcp.run(transport="streamable-http")
    except KeyboardInterrupt:
        logger.info("AgentBox server stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        raise
