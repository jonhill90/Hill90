"""Identity tools — exposes agent SOUL.md and RULES.md."""

from __future__ import annotations

import json
import os

from fastmcp import FastMCP

from app.config import AgentConfig

server = FastMCP("IdentityTools")
_soul: str = ""
_rules: str = ""
_config: AgentConfig | None = None


def configure(config: AgentConfig) -> None:
    global _soul, _rules, _config
    _config = config

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
    return json.dumps({
        "id": _config.id if _config else "unknown",
        "name": _config.name if _config else "Unknown Agent",
        "description": _config.description if _config else "",
        "soul": _soul,
        "rules": _rules,
    })
