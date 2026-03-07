"""Identity tools — exposes agent SOUL.md and RULES.md.

DEPRECATED — scheduled for removal in Phase 2 (runtime-first migration).
Agent reads /etc/agentbox/SOUL.md and RULES.md directly.
"""

from __future__ import annotations

import json
import os
import time

from fastmcp import FastMCP

from app.config import AgentConfig
from app.events import EventEmitter

server = FastMCP("IdentityTools")
_soul: str = ""
_rules: str = ""
_config: AgentConfig | None = None
_emitter: EventEmitter | None = None


def configure(config: AgentConfig, emitter: EventEmitter | None = None) -> None:
    global _soul, _rules, _config, _emitter
    _config = config
    _emitter = emitter

    soul_path = "/etc/agentbox/SOUL.md"
    rules_path = "/etc/agentbox/RULES.md"

    if os.path.exists(soul_path):
        with open(soul_path) as f:
            _soul = f.read()

    if os.path.exists(rules_path):
        with open(rules_path) as f:
            _rules = f.read()


@server.tool()
async def get_identity() -> str:
    """Return this agent's identity, goals, rules, and constraints.

    Returns:
        JSON string with agent id, name, description, soul, and rules
    """
    t0 = time.monotonic()
    result = {
        "id": _config.id if _config else "unknown",
        "name": _config.name if _config else "Unknown Agent",
        "description": _config.description if _config else "",
        "soul": _soul,
        "rules": _rules,
    }
    duration_ms = int((time.monotonic() - t0) * 1000)

    if _emitter:
        total_size = len(_soul) + len(_rules)
        _emitter.emit(
            type="identity_read",
            tool="identity",
            input_summary="SOUL.md + RULES.md",
            output_summary=f"{total_size} bytes",
            duration_ms=duration_ms,
            success=True,
        )

    return json.dumps(result)
