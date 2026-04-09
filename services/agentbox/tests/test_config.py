"""Tests for app.config — Pydantic models for agent.yml."""

import tempfile
from pathlib import Path

import pytest
import yaml

from app.config import AgentConfig, FilesystemConfig, ShellConfig, ToolsConfig


class TestAgentConfig:
    def test_from_file_valid(self, tmp_path):
        config_data = {
            "version": 1,
            "id": "test-agent",
            "name": "Test Agent",
            "description": "A test agent",
            "soul_path": "SOUL.md",
            "rules_path": "RULES.md",
            "tools": {
                "shell": {
                    "enabled": True,
                    "allowed_binaries": ["/usr/bin/git"],
                    "denied_patterns": ["rm\\s+-rf"],
                    "max_timeout": 120,
                },
                "filesystem": {
                    "enabled": True,
                    "read_only": False,
                    "allowed_paths": ["/workspace"],
                    "denied_paths": ["/etc/shadow"],
                },
                "health": {"enabled": True},
            },
            "resources": {"cpus": "2.0", "mem_limit": "2g", "pids_limit": 300},
            "state": {
                "workspace": "/workspace",
                "logs": "/var/log/agentbox",
                "data": "/data",
            },
        }
        config_file = tmp_path / "agent.yml"
        config_file.write_text(yaml.dump(config_data))

        config = AgentConfig.from_file(config_file)

        assert config.id == "test-agent"
        assert config.name == "Test Agent"
        assert config.tools.shell.enabled is True
        assert "/usr/bin/git" in config.tools.shell.allowed_binaries
        assert config.tools.filesystem.read_only is False
        assert config.resources.cpus == "2.0"
        assert config.resources.pids_limit == 300

    def test_from_file_minimal(self, tmp_path):
        config_data = {
            "version": 1,
            "id": "minimal",
            "name": "Minimal Agent",
            "description": "Minimal config",
        }
        config_file = tmp_path / "agent.yml"
        config_file.write_text(yaml.dump(config_data))

        config = AgentConfig.from_file(config_file)

        assert config.id == "minimal"
        assert config.tools.shell.enabled is False
        assert config.tools.filesystem.enabled is False
        assert config.tools.health.enabled is True
        assert config.resources.cpus == "1.0"
        assert config.resources.mem_limit == "1g"

    def test_from_file_missing_required_field(self, tmp_path):
        config_data = {"version": 1, "id": "no-name"}
        config_file = tmp_path / "agent.yml"
        config_file.write_text(yaml.dump(config_data))

        with pytest.raises(Exception):
            AgentConfig.from_file(config_file)

    def test_from_file_not_found(self):
        with pytest.raises(FileNotFoundError):
            AgentConfig.from_file("/nonexistent/agent.yml")


class TestShellConfig:
    def test_defaults(self):
        config = ShellConfig()
        assert config.enabled is False
        assert config.allowed_binaries == []
        assert config.denied_patterns == []
        assert config.max_timeout == 300


class TestFilesystemConfig:
    def test_defaults(self):
        config = FilesystemConfig()
        assert config.enabled is False
        assert config.read_only is False
        assert config.allowed_paths == ["/home/agentuser", "/workspace"]
        assert "/etc/shadow" in config.denied_paths
