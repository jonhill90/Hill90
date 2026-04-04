"""Functional tests for app.server — exercises actual Starlette app behavior.

These tests use Starlette TestClient to verify endpoint behavior through
the ASGI application, providing primary behavioral proof that the server
works correctly after the FastMCP-to-Starlette migration.
"""

import json
import os
from unittest.mock import MagicMock

import pytest
from starlette.testclient import TestClient

from app.config import AgentConfig
from app.events import EventEmitter
from app.server import create_app


def _make_config(**overrides) -> AgentConfig:
    """Create a minimal AgentConfig for testing."""
    defaults = {
        "version": 1,
        "id": "test-agent",
        "name": "Test Agent",
        "description": "A test agent",
    }
    defaults.update(overrides)
    return AgentConfig(**defaults)


def _make_client(tmp_path, work_token="test-token-123", config=None):
    """Create a TestClient with a real Starlette app."""
    if config is None:
        config = _make_config()
    log_path = tmp_path / "events.jsonl"
    emitter = EventEmitter(str(log_path))
    app = create_app(config, emitter, work_token)
    return TestClient(app), emitter, log_path


class TestHealthEndpoint:
    def test_health_returns_200_with_agent_id(self, tmp_path):
        """FN1: GET /health returns 200 with expected payload."""
        client, _, _ = _make_client(tmp_path)
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "healthy"
        assert body["agent"] == "test-agent"


class TestWorkEndpointAuth:
    def test_work_unauthorized_returns_401(self, tmp_path):
        """FN2: POST /work without auth returns 401."""
        client, _, _ = _make_client(tmp_path)
        response = client.post(
            "/work",
            json={"type": "test", "payload": {}},
        )
        assert response.status_code == 401
        assert response.json()["error"] == "unauthorized"

    def test_work_valid_returns_accepted(self, tmp_path):
        """FN3: POST /work with valid auth returns accepted ack."""
        client, _, _ = _make_client(tmp_path)
        response = client.post(
            "/work",
            json={"type": "shell_cmd", "payload": {"command": "echo hi"}},
            headers={"Authorization": "Bearer test-token-123"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["accepted"] is True
        assert "work_id" in body
        assert body["type"] == "shell_cmd"


class TestWorkEndpointEvents:
    def test_work_emits_events(self, tmp_path):
        """FN4: POST /work with valid auth emits work_received + work_completed events."""
        client, _, log_path = _make_client(tmp_path)
        client.post(
            "/work",
            json={"type": "test_work", "payload": {}},
            headers={"Authorization": "Bearer test-token-123"},
        )
        # Read events from JSONL
        events = [json.loads(line) for line in log_path.read_text().strip().split("\n")]
        event_types = [e["type"] for e in events]
        assert "work_received" in event_types
        assert "work_completed" in event_types
        # Both should be runtime tool events
        for e in events:
            assert e["tool"] == "runtime"


class TestWorkEndpointValidation:
    def test_work_invalid_json_returns_400(self, tmp_path):
        """FN5: POST /work with invalid JSON returns 400."""
        client, _, _ = _make_client(tmp_path)
        response = client.post(
            "/work",
            content=b"not json",
            headers={
                "Authorization": "Bearer test-token-123",
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 400
        assert response.json()["error"] == "validation_error"

    def test_work_missing_type_returns_400(self, tmp_path):
        """FN6: POST /work missing 'type' field returns 400."""
        client, _, _ = _make_client(tmp_path)
        response = client.post(
            "/work",
            json={"payload": {}},
            headers={"Authorization": "Bearer test-token-123"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "validation_error"


class TestToolsConfigBackwardCompat:
    def test_server_starts_with_tools_enabled(self, tmp_path):
        """FN7: Server starts with tools.shell.enabled=true — no crash."""
        config = _make_config(
            tools={
                "shell": {"enabled": True, "allowed_binaries": ["/usr/bin/git"]},
                "filesystem": {"enabled": True, "allowed_paths": ["/workspace"]},
            }
        )
        client, _, _ = _make_client(tmp_path, config=config)
        response = client.get("/health")
        assert response.status_code == 200

    def test_server_starts_with_tools_disabled(self, tmp_path):
        """FN8: Server starts with tools.shell.enabled=false — no crash."""
        config = _make_config(
            tools={
                "shell": {"enabled": False},
                "filesystem": {"enabled": False},
            }
        )
        client, _, _ = _make_client(tmp_path, config=config)
        response = client.get("/health")
        assert response.status_code == 200

    def test_tools_config_does_not_affect_endpoints(self, tmp_path):
        """FN9: Tools config flags have no effect on /health or /work behavior."""
        # Create two apps — one with tools enabled, one disabled
        config_enabled = _make_config(
            tools={
                "shell": {"enabled": True},
                "filesystem": {"enabled": True},
            }
        )
        config_disabled = _make_config(
            tools={
                "shell": {"enabled": False},
                "filesystem": {"enabled": False},
            }
        )
        client_enabled, _, _ = _make_client(tmp_path, config=config_enabled)
        client_disabled, _, _ = _make_client(tmp_path, config=config_disabled)

        # Both should return identical health responses
        r1 = client_enabled.get("/health")
        r2 = client_disabled.get("/health")
        assert r1.json() == r2.json()

        # Both should accept work identically
        work_payload = {"type": "test", "payload": {}}
        headers = {"Authorization": "Bearer test-token-123"}
        r3 = client_enabled.post("/work", json=work_payload, headers=headers)
        r4 = client_disabled.post("/work", json=work_payload, headers=headers)
        assert r3.status_code == r4.status_code == 200
        assert r3.json()["accepted"] == r4.json()["accepted"] is True


class TestShellCommandFunctional:
    """Functional tests for shell_command work type through the Starlette app."""

    def test_shell_command_disabled_returns_400(self, tmp_path):
        """SF1: shell_command with shell disabled returns 400."""
        config = _make_config(tools={"shell": {"enabled": False}})
        client, _, _ = _make_client(tmp_path, config=config)
        response = client.post(
            "/work",
            json={"type": "shell_command", "payload": {"command": "echo hi"}},
            headers={"Authorization": "Bearer test-token-123"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "shell_disabled"

    def test_shell_command_enabled_returns_200(self, tmp_path, monkeypatch):
        """SF2: shell_command with shell enabled returns 200 accepted."""
        config = _make_config(tools={"shell": {"enabled": True}})

        async def mock_execute(command, timeout=30, **kwargs):
            return json.dumps({"success": True, "exit_code": 0, "stdout": "hi\n", "stderr": ""})
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute)

        client, _, _ = _make_client(tmp_path, config=config)
        response = client.post(
            "/work",
            json={"type": "shell_command", "payload": {"command": "echo hi"}},
            headers={"Authorization": "Bearer test-token-123"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["accepted"] is True
        assert "command_id" in body

    def test_shell_command_success_path(self, tmp_path):
        """SF4: shell_command with allowed binary succeeds through full stack."""
        from app import shell

        config = _make_config(
            tools={"shell": {"enabled": True, "allowed_binaries": ["echo"]}}
        )
        client, _, log_path = _make_client(tmp_path, config=config)

        # Patch cwd to tmp_path (default is /workspace which doesn't exist in tests)
        original_execute = shell._policy.execute
        original_streaming = shell._policy.execute_streaming

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        response = client.post(
            "/work",
            json={"type": "shell_command", "payload": {"command": "echo sf4-marker"}},
            headers={"Authorization": "Bearer test-token-123"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["accepted"] is True
        assert "command_id" in body

        # Wait for background thread
        import time
        time.sleep(1.0)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n")]
        completed = [e for e in events if e["type"] == "command_complete"]
        assert len(completed) == 1
        assert completed[0]["success"] is True
        assert "exit 0" in completed[0]["output_summary"]

    def test_shell_configure_called_when_enabled(self):
        """SF3: server.py calls shell.configure when shell is enabled."""
        import inspect
        import app.server

        source = inspect.getsource(app.server)
        assert "shell.configure(" in source
