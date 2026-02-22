"""Health check and resource stats tools."""

from __future__ import annotations

import json
import os

from fastmcp import FastMCP

from app.config import AgentConfig

server = FastMCP("HealthTools")
_config: AgentConfig | None = None


def configure(config: AgentConfig) -> None:
    global _config
    _config = config


@server.tool()
async def health_check() -> str:
    """Return agent health status and resource usage.

    Returns:
        JSON string with health status, agent info, and resource stats
    """
    agent_id = _config.id if _config else "unknown"

    # Basic resource stats
    try:
        import psutil

        mem = psutil.virtual_memory()
        disk = psutil.disk_usage("/workspace")
        stats = {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory_used_mb": round(mem.used / 1024 / 1024, 1),
            "memory_total_mb": round(mem.total / 1024 / 1024, 1),
            "memory_percent": mem.percent,
            "disk_used_mb": round(disk.used / 1024 / 1024, 1),
            "disk_total_mb": round(disk.total / 1024 / 1024, 1),
            "disk_percent": disk.percent,
            "pid_count": len(psutil.pids()),
        }
    except ImportError:
        stats = {"error": "psutil not available"}
    except Exception as e:
        stats = {"error": f"Resource stats failed: {e}"}

    return json.dumps({
        "status": "healthy",
        "agent": agent_id,
        "pid": os.getpid(),
        "resources": stats,
    })
