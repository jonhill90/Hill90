"""Pydantic models for agent.yml configuration validation."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field


class ShellConfig(BaseModel):
    enabled: bool = False
    allowed_binaries: list[str] = Field(default_factory=list)
    denied_patterns: list[str] = Field(default_factory=list)
    max_timeout: int = 300


class FilesystemConfig(BaseModel):
    enabled: bool = False
    read_only: bool = False
    allowed_paths: list[str] = Field(default_factory=lambda: ["/workspace"])
    denied_paths: list[str] = Field(
        default_factory=lambda: ["/etc/shadow", "/etc/passwd", "/root"]
    )


class HealthConfig(BaseModel):
    # Deprecated: kept for YAML compatibility with existing agent.yml files.
    # The health MCP tool was removed in Phase 2; Docker HEALTHCHECK + /health HTTP suffice.
    enabled: bool = True


class ToolsConfig(BaseModel):
    shell: ShellConfig = Field(default_factory=ShellConfig)
    filesystem: FilesystemConfig = Field(default_factory=FilesystemConfig)
    health: HealthConfig = Field(default_factory=HealthConfig)


class ResourcesConfig(BaseModel):
    cpus: str = "1.0"
    mem_limit: str = "1g"
    pids_limit: int = 200


class StateConfig(BaseModel):
    workspace: str = "/workspace"
    logs: str = "/var/log/agentbox"
    data: str = "/data"


class AgentConfig(BaseModel):
    version: int = 1
    id: str
    name: str
    description: str
    soul_path: str = "SOUL.md"
    rules_path: str = "RULES.md"
    tools: ToolsConfig = Field(default_factory=ToolsConfig)
    resources: ResourcesConfig = Field(default_factory=ResourcesConfig)
    state: StateConfig = Field(default_factory=StateConfig)

    @classmethod
    def from_file(cls, path: str | Path) -> AgentConfig:
        """Load and validate agent config from a YAML file."""
        with open(path) as f:
            data = yaml.safe_load(f)
        return cls(**data)
