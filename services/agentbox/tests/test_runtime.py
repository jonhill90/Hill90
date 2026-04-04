"""Tests for app.runtime — AgentRuntime workload receiver."""

import json
import os
import re
import time

import pytest

from app import shell
from app.config import AgentConfig, ShellConfig
from app.events import EventEmitter
from app.runtime import AgentRuntime


def _make_config() -> AgentConfig:
    return AgentConfig(
        version=1,
        id="test-agent",
        name="Test Agent",
        description="A test agent",
    )


def _make_runtime(tmp_path, work_token="test-token-123"):
    log_path = tmp_path / "events.jsonl"
    emitter = EventEmitter(str(log_path))
    config = _make_config()
    return AgentRuntime(config, emitter, work_token), emitter, log_path


class _MockRequest:
    """Minimal Starlette Request mock for testing handle_work."""

    def __init__(self, headers=None, body=None):
        self.headers = headers or {}
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("No body")
        return json.loads(self._body)


class TestRuntimeLoadsIdentity:
    def test_runtime_loads_identity_files(self, tmp_path, monkeypatch):
        """Runtime should load SOUL.md and RULES.md from /etc/agentbox/."""
        soul_dir = tmp_path / "etc" / "agentbox"
        soul_dir.mkdir(parents=True)
        (soul_dir / "SOUL.md").write_text("# Test Soul\nYou are a test agent.")
        (soul_dir / "RULES.md").write_text("# Test Rules\nDo not break things.")

        # Patch os.path.exists and open to use our temp files
        real_exists = os.path.exists

        def mock_exists(path):
            if path == "/etc/agentbox/SOUL.md":
                return True
            if path == "/etc/agentbox/RULES.md":
                return True
            return real_exists(path)

        import builtins
        real_builtin_open = builtins.open

        def mock_open(path, *args, **kwargs):
            if path == "/etc/agentbox/SOUL.md":
                return real_builtin_open(str(soul_dir / "SOUL.md"), *args, **kwargs)
            if path == "/etc/agentbox/RULES.md":
                return real_builtin_open(str(soul_dir / "RULES.md"), *args, **kwargs)
            return real_builtin_open(path, *args, **kwargs)

        monkeypatch.setattr(os.path, "exists", mock_exists)
        monkeypatch.setattr(builtins, "open", mock_open)

        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))
        runtime = AgentRuntime(_make_config(), emitter, None)

        assert "Test Soul" in runtime.soul
        assert "Test Rules" in runtime.rules

    def test_runtime_missing_identity_files(self, tmp_path, monkeypatch):
        """Runtime should handle missing identity files gracefully."""
        monkeypatch.setattr(os.path, "exists", lambda path: False)

        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))
        runtime = AgentRuntime(_make_config(), emitter, None)

        assert runtime.soul == ""
        assert runtime.rules == ""


class TestWorkAuth:
    @pytest.mark.asyncio
    async def test_work_unauthorized_no_token(self, tmp_path):
        """POST /work without Authorization header returns 401."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={},
            body='{"type":"test"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 401
        body = json.loads(response.body)
        assert body["error"] == "unauthorized"

    @pytest.mark.asyncio
    async def test_work_unauthorized_wrong_token(self, tmp_path):
        """POST /work with wrong Bearer token returns 401."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer wrong-token"},
            body='{"type":"test"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_work_unauthorized_empty_header(self, tmp_path):
        """POST /work with empty Authorization header returns 401."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": ""},
            body='{"type":"test"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_work_unauthorized_no_work_token_configured(self, tmp_path):
        """POST /work when no WORK_TOKEN is configured returns 401."""
        runtime, _, _ = _make_runtime(tmp_path, work_token=None)
        request = _MockRequest(
            headers={"authorization": "Bearer anything"},
            body='{"type":"test"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 401


class TestWorkValidation:
    @pytest.mark.asyncio
    async def test_work_rejects_malformed_json(self, tmp_path):
        """POST /work with malformed JSON returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body=None,  # will raise on .json()
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "validation_error"

    @pytest.mark.asyncio
    async def test_work_rejects_missing_type(self, tmp_path):
        """POST /work without 'type' field returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"payload":{}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "validation_error"
        assert "type" in body["detail"]

    @pytest.mark.asyncio
    async def test_work_rejects_empty_type(self, tmp_path):
        """POST /work with empty 'type' field returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":""}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_work_rejects_bad_payload(self, tmp_path):
        """POST /work with non-dict payload returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","payload":"not-a-dict"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "validation_error"
        assert "payload" in body["detail"]


class TestCorrelationIdValidation:
    @pytest.mark.asyncio
    async def test_work_rejects_correlation_id_number(self, tmp_path):
        """POST /work with numeric correlation_id returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":42}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "validation_error"
        assert "correlation_id" in body["detail"]

    @pytest.mark.asyncio
    async def test_work_rejects_correlation_id_object(self, tmp_path):
        """POST /work with object correlation_id returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":{"nested":true}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_work_rejects_correlation_id_array(self, tmp_path):
        """POST /work with array correlation_id returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":["a","b"]}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_work_rejects_correlation_id_bool(self, tmp_path):
        """POST /work with boolean correlation_id returns 400."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":true}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_work_accepts_correlation_id_null(self, tmp_path):
        """POST /work with null correlation_id is valid."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":null}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_work_accepts_correlation_id_string(self, tmp_path):
        """POST /work with string correlation_id is valid."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":"abc-123"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 200


class TestWorkAccept:
    @pytest.mark.asyncio
    async def test_work_accepts_valid(self, tmp_path):
        """POST /work with valid payload returns 200 with ack."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"custom_task","payload":{"cmd":"echo hello"},"correlation_id":"corr-1"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["accepted"] is True
        assert body["type"] == "custom_task"
        assert "work_id" in body

    @pytest.mark.asyncio
    async def test_work_accepts_minimal(self, tmp_path):
        """POST /work with only type field (payload defaults to {})."""
        runtime, _, _ = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"ping"}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["accepted"] is True
        assert body["type"] == "ping"


class TestWorkEvents:
    @pytest.mark.asyncio
    async def test_emits_work_received(self, tmp_path):
        """POST /work emits a work_received event."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test"}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        received = [e for e in events if e["type"] == "work_received"]
        assert len(received) == 1
        assert received[0]["tool"] == "runtime"
        assert "type=test" in received[0]["input_summary"]

    @pytest.mark.asyncio
    async def test_emits_work_completed(self, tmp_path):
        """POST /work emits a work_completed event."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test"}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        completed = [e for e in events if e["type"] == "work_completed"]
        assert len(completed) == 1
        assert completed[0]["tool"] == "runtime"
        assert completed[0]["success"] is True

    @pytest.mark.asyncio
    async def test_correlation_id_in_events(self, tmp_path):
        """Correlation ID from work item appears in event summaries."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":"my-corr-id"}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        for event in events:
            assert "my-corr-id" in event["input_summary"]

    @pytest.mark.asyncio
    async def test_work_id_in_event_metadata(self, tmp_path):
        """Work ID from response appears in event metadata."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test"}',
        )
        response = await runtime.handle_work(request)
        response_body = json.loads(response.body)
        work_id = response_body["work_id"]

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        for event in events:
            assert event.get("metadata", {}).get("work_id") == work_id

    @pytest.mark.asyncio
    async def test_no_token_in_events(self, tmp_path):
        """WORK_TOKEN must never appear in event data."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test"}',
        )
        await runtime.handle_work(request)

        raw = log_path.read_text()
        assert "test-token-123" not in raw


class TestWorkFailedEvents:
    @pytest.mark.asyncio
    async def test_emits_work_failed_on_malformed_json(self, tmp_path):
        """Malformed JSON emits work_failed event."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body=None,
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 1
        assert failed[0]["tool"] == "runtime"
        assert failed[0]["success"] is False
        assert "Malformed JSON" in failed[0]["output_summary"]

    @pytest.mark.asyncio
    async def test_emits_work_failed_on_missing_type(self, tmp_path):
        """Missing type field emits work_failed event."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"payload":{}}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 1
        assert failed[0]["success"] is False

    @pytest.mark.asyncio
    async def test_emits_work_failed_on_bad_payload(self, tmp_path):
        """Non-dict payload emits work_failed with work_type in summary."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"mytype","payload":"not-a-dict"}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 1
        assert "type=mytype" in failed[0]["input_summary"]
        assert "payload" in failed[0]["output_summary"]

    @pytest.mark.asyncio
    async def test_emits_work_failed_on_bad_correlation_id(self, tmp_path):
        """Non-string correlation_id emits work_failed event."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test","correlation_id":123}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 1
        assert "correlation_id" in failed[0]["output_summary"]

    @pytest.mark.asyncio
    async def test_no_work_failed_on_auth_failure(self, tmp_path):
        """Auth failures do NOT emit work_failed (not a work failure)."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer wrong-token"},
            body='{"type":"test"}',
        )
        await runtime.handle_work(request)

        content = log_path.read_text().strip()
        if content:
            events = [json.loads(line) for line in content.split("\n") if line]
            failed = [e for e in events if e["type"] == "work_failed"]
            assert len(failed) == 0
        # Empty log is also correct — no events at all on auth failure

    @pytest.mark.asyncio
    async def test_no_work_failed_on_success(self, tmp_path):
        """Successful work does NOT emit work_failed."""
        runtime, _, log_path = _make_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"test"}',
        )
        await runtime.handle_work(request)

        events = [json.loads(line) for line in log_path.read_text().strip().split("\n") if line]
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 0


# ---------------------------------------------------------------------------
# Shell command tests
# ---------------------------------------------------------------------------

def _make_shell_runtime(tmp_path, shell_enabled=True, max_timeout=300, work_token="test-token-123"):
    """Create an AgentRuntime with shell tools configured."""
    log_path = tmp_path / "events.jsonl"
    emitter = EventEmitter(str(log_path))
    config = AgentConfig(
        version=1,
        id="test-agent",
        name="Test Agent",
        description="A test agent",
        tools={"shell": {"enabled": shell_enabled, "max_timeout": max_timeout}},
    )
    return AgentRuntime(config, emitter, work_token), emitter, log_path


def _read_events(log_path):
    """Read all events from the JSONL log file."""
    content = log_path.read_text().strip()
    if not content:
        return []
    return [json.loads(line) for line in content.split("\n") if line]


class TestShellCommand:
    """Tests for shell_command work type routing."""

    @pytest.mark.asyncio
    async def test_shell_command_accepted(self, tmp_path, monkeypatch):
        """SC1: shell_command with valid payload returns 200 accepted."""
        runtime, _, log_path = _make_shell_runtime(tmp_path)

        async def mock_execute(command, timeout=30, **kwargs):
            return json.dumps({"success": True, "exit_code": 0, "stdout": "hello\n", "stderr": ""})
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute)

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hello"}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 200
        body = json.loads(response.body)
        assert body["accepted"] is True

    @pytest.mark.asyncio
    async def test_shell_command_ack_includes_command_id(self, tmp_path, monkeypatch):
        """SC2: shell_command response includes a UUID command_id."""
        runtime, _, _ = _make_shell_runtime(tmp_path)

        async def mock_execute(command, timeout=30, **kwargs):
            return json.dumps({"success": True, "exit_code": 0, "stdout": "", "stderr": ""})
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute)

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hello"}}',
        )
        response = await runtime.handle_work(request)
        body = json.loads(response.body)
        assert "command_id" in body
        assert re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            body["command_id"],
        )

    @pytest.mark.asyncio
    async def test_shell_command_rejects_missing_command(self, tmp_path):
        """SC3: shell_command without payload.command returns 400."""
        runtime, _, _ = _make_shell_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "validation_error"

    @pytest.mark.asyncio
    async def test_shell_command_rejects_empty_command(self, tmp_path):
        """SC4: shell_command with empty command returns 400."""
        runtime, _, _ = _make_shell_runtime(tmp_path)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":""}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "validation_error"

    @pytest.mark.asyncio
    async def test_shell_command_rejects_when_disabled(self, tmp_path):
        """SC5: shell_command with shell disabled returns 400 shell_disabled."""
        runtime, _, _ = _make_shell_runtime(tmp_path, shell_enabled=False)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hello"}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 400
        body = json.loads(response.body)
        assert body["error"] == "shell_disabled"

    @pytest.mark.asyncio
    async def test_shell_command_emits_work_failed_when_disabled(self, tmp_path):
        """SC6: shell_command with shell disabled emits work_failed event."""
        runtime, _, log_path = _make_shell_runtime(tmp_path, shell_enabled=False)
        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hello"}}',
        )
        await runtime.handle_work(request)

        events = _read_events(log_path)
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 1
        assert "shell_disabled" in failed[0]["output_summary"]

    @pytest.mark.asyncio
    async def test_shell_command_timeout_clamped_to_max(self, tmp_path, monkeypatch):
        """SC7: payload.timeout exceeding max_timeout is clamped."""
        runtime, _, _ = _make_shell_runtime(tmp_path, max_timeout=10)

        captured = {}

        async def mock_execute(command, timeout=30, **kwargs):
            captured["timeout"] = timeout
            return json.dumps({"success": True, "exit_code": 0, "stdout": "", "stderr": ""})
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute)

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hi","timeout":999}}',
        )
        await runtime.handle_work(request)
        # Wait for background thread to call mock
        time.sleep(0.5)
        assert captured["timeout"] == 10

    @pytest.mark.asyncio
    async def test_shell_command_timeout_defaults_to_30(self, tmp_path, monkeypatch):
        """SC8: Missing payload.timeout defaults to 30."""
        runtime, _, _ = _make_shell_runtime(tmp_path, max_timeout=300)

        captured = {}

        async def mock_execute(command, timeout=30, **kwargs):
            captured["timeout"] = timeout
            return json.dumps({"success": True, "exit_code": 0, "stdout": "", "stderr": ""})
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute)

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hi"}}',
        )
        await runtime.handle_work(request)
        time.sleep(0.5)
        assert captured["timeout"] == 30

    @pytest.mark.asyncio
    async def test_shell_command_timeout_invalid_uses_default(self, tmp_path, monkeypatch):
        """SC9: Non-numeric payload.timeout falls back to 30."""
        runtime, _, _ = _make_shell_runtime(tmp_path, max_timeout=300)

        captured = {}

        async def mock_execute(command, timeout=30, **kwargs):
            captured["timeout"] = timeout
            return json.dumps({"success": True, "exit_code": 0, "stdout": "", "stderr": ""})
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute)

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo hi","timeout":"abc"}}',
        )
        await runtime.handle_work(request)
        time.sleep(0.5)
        assert captured["timeout"] == 30

    @pytest.mark.asyncio
    async def test_shell_command_four_event_lifecycle(self, tmp_path):
        """SC10: shell_command emits work_received, command_start, command_complete, work_completed."""
        runtime, emitter, log_path = _make_shell_runtime(tmp_path, max_timeout=300)

        # Configure real shell so we get command_start/command_complete events
        shell_config = ShellConfig(enabled=True, allowed_binaries=[], denied_patterns=[], max_timeout=300)
        shell.configure(shell_config, emitter)
        # Override cwd to tmp_path for safety
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute
        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo lifecycle"}}',
        )
        await runtime.handle_work(request)
        time.sleep(1.0)

        events = _read_events(log_path)
        event_types = [e["type"] for e in events]
        assert "work_received" in event_types
        assert "command_start" in event_types
        assert "command_complete" in event_types
        assert "work_completed" in event_types

    @pytest.mark.asyncio
    async def test_shell_command_all_events_share_work_id(self, tmp_path):
        """SC11: All 4 lifecycle events share the same work_id."""
        runtime, emitter, log_path = _make_shell_runtime(tmp_path, max_timeout=300)

        shell_config = ShellConfig(enabled=True, allowed_binaries=[], denied_patterns=[], max_timeout=300)
        shell.configure(shell_config, emitter)
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute
        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo wid"}}',
        )
        response = await runtime.handle_work(request)
        resp_body = json.loads(response.body)
        work_id = resp_body["work_id"]

        time.sleep(1.0)

        events = _read_events(log_path)
        assert len(events) >= 4
        for event in events:
            assert event.get("metadata", {}).get("work_id") == work_id

    @pytest.mark.asyncio
    async def test_shell_command_shell_events_have_command_id(self, tmp_path):
        """SC12: command_start and command_complete events have command_id in metadata."""
        runtime, emitter, log_path = _make_shell_runtime(tmp_path, max_timeout=300)

        shell_config = ShellConfig(enabled=True, allowed_binaries=[], denied_patterns=[], max_timeout=300)
        shell.configure(shell_config, emitter)
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute
        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo cid"}}',
        )
        response = await runtime.handle_work(request)
        resp_body = json.loads(response.body)
        command_id = resp_body["command_id"]

        time.sleep(1.0)

        events = _read_events(log_path)
        shell_events = [e for e in events if e["type"] in ("command_start", "command_complete")]
        assert len(shell_events) == 2
        for event in shell_events:
            assert event["metadata"]["command_id"] == command_id

    @pytest.mark.asyncio
    async def test_shell_command_work_completed_has_command_id(self, tmp_path):
        """SC13: work_completed event has command_id in metadata."""
        runtime, emitter, log_path = _make_shell_runtime(tmp_path, max_timeout=300)

        shell_config = ShellConfig(enabled=True, allowed_binaries=[], denied_patterns=[], max_timeout=300)
        shell.configure(shell_config, emitter)
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute
        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo done"}}',
        )
        response = await runtime.handle_work(request)
        resp_body = json.loads(response.body)
        command_id = resp_body["command_id"]

        time.sleep(1.0)

        events = _read_events(log_path)
        completed = [e for e in events if e["type"] == "work_completed"]
        assert len(completed) == 1
        assert completed[0]["metadata"]["command_id"] == command_id

    @pytest.mark.asyncio
    async def test_shell_command_failed_emits_work_failed(self, tmp_path, monkeypatch):
        """SC14: Exception in shell execution emits work_failed with command_id."""
        runtime, _, log_path = _make_shell_runtime(tmp_path, max_timeout=300)

        async def mock_execute_fail(command, timeout=30, **kwargs):
            raise RuntimeError("shell boom")
        monkeypatch.setattr("app.runtime.shell.execute_command", mock_execute_fail)

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo fail"}}',
        )
        response = await runtime.handle_work(request)
        resp_body = json.loads(response.body)
        command_id = resp_body["command_id"]

        time.sleep(1.0)

        events = _read_events(log_path)
        failed = [e for e in events if e["type"] == "work_failed"]
        assert len(failed) == 1
        assert failed[0]["metadata"]["command_id"] == command_id

    @pytest.mark.asyncio
    async def test_shell_command_success_path(self, tmp_path):
        """SC15: shell_command with allowed binary succeeds end-to-end (success=True)."""
        runtime, emitter, log_path = _make_shell_runtime(tmp_path, max_timeout=300)

        # Configure shell with "echo" in allowlist — resolved to full path at init
        shell_config = ShellConfig(
            enabled=True, allowed_binaries=["echo"], denied_patterns=[], max_timeout=300,
        )
        shell.configure(shell_config, emitter)
        # Patch cwd to tmp_path so subprocess can find a valid working directory
        original_execute = shell._policy.execute

        def patched_execute(command, timeout=30, cwd=str(tmp_path)):
            return original_execute(command, timeout=timeout, cwd=cwd)
        shell._policy.execute = patched_execute
        original_streaming = shell._policy.execute_streaming

        def patched_streaming(command, timeout=30, cwd=str(tmp_path), **kwargs):
            return original_streaming(command, timeout=timeout, cwd=cwd, **kwargs)
        shell._policy.execute_streaming = patched_streaming

        request = _MockRequest(
            headers={"authorization": "Bearer test-token-123"},
            body='{"type":"shell_command","payload":{"command":"echo success-marker"}}',
        )
        response = await runtime.handle_work(request)
        assert response.status_code == 200
        resp_body = json.loads(response.body)
        assert resp_body["accepted"] is True

        time.sleep(1.0)

        events = _read_events(log_path)
        event_types = [e["type"] for e in events]
        # Full 4-event lifecycle
        assert "work_received" in event_types
        assert "command_start" in event_types
        assert "command_complete" in event_types
        assert "work_completed" in event_types

        # command_complete reports success=True with exit 0
        cmd_complete = [e for e in events if e["type"] == "command_complete"][0]
        assert cmd_complete["success"] is True
        assert "exit 0" in cmd_complete["output_summary"]

        # work_completed reports success=True
        work_completed = [e for e in events if e["type"] == "work_completed"][0]
        assert work_completed["success"] is True
