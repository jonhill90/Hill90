"""Health check and resource stats tools.

DEPRECATED — scheduled for removal in Phase 2 (runtime-first migration).
Platform queries Docker stats API for health metrics.
Docker healthcheck (HTTP /health) is sufficient for liveness.
"""

from __future__ import annotations

import json
import os
import time

from fastmcp import FastMCP

from app.config import AgentConfig
from app.events import EventEmitter

server = FastMCP("HealthTools")
_config: AgentConfig | None = None
_emitter: EventEmitter | None = None


def configure(config: AgentConfig, emitter: EventEmitter | None = None) -> None:
    global _config, _emitter
    _config = config
    _emitter = emitter


@server.tool()
async def health_check() -> str:
    """Return agent health status and resource usage.

    Returns:
        JSON string with health status, agent info, and resource stats
    """
    t0 = time.monotonic()
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

    duration_ms = int((time.monotonic() - t0) * 1000)

    if _emitter:
        cpu = stats.get("cpu_percent", "?")
        mem_pct = stats.get("memory_percent", "?")
        disk_pct = stats.get("disk_percent", "?")
        _emitter.emit(
            type="health_check",
            tool="health",
            input_summary="health_check",
            output_summary=f"cpu={cpu}%, mem={mem_pct}%, disk={disk_pct}%",
            duration_ms=duration_ms,
            success=True,
        )

    return json.dumps({
        "status": "healthy",
        "agent": agent_id,
        "pid": os.getpid(),
        "resources": stats,
    })
