"""Tests for app.events — structured event emitter for agent observability."""

import json
import threading

from app.events import EventEmitter


class TestEventEmitter:
    def test_emit_writes_jsonl_line(self, tmp_path):
        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))

        emitter.emit(
            type="command_complete",
            tool="shell",
            input_summary="echo hello",
            output_summary="exit 0, 12 bytes stdout",
            duration_ms=42,
            success=True,
        )

        lines = log_path.read_text().strip().split("\n")
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["type"] == "command_complete"
        assert event["tool"] == "shell"
        assert event["input_summary"] == "echo hello"
        assert event["output_summary"] == "exit 0, 12 bytes stdout"
        assert event["duration_ms"] == 42
        assert event["success"] is True
        assert "id" in event
        assert "timestamp" in event

    def test_emit_truncates_input_summary(self, tmp_path):
        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))
        long_input = "x" * 300

        emitter.emit(
            type="command_start",
            tool="shell",
            input_summary=long_input,
            output_summary=None,
            duration_ms=None,
            success=None,
        )

        event = json.loads(log_path.read_text().strip())
        assert len(event["input_summary"]) == 200

    def test_emit_output_summary_is_metadata_only(self, tmp_path):
        """Emitter passes output_summary through exactly as given.
        Callers are responsible for passing metadata-only summaries."""
        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))

        emitter.emit(
            type="file_read",
            tool="filesystem",
            input_summary="/workspace/README.md",
            output_summary="2431 bytes",
            duration_ms=8,
            success=True,
        )

        event = json.loads(log_path.read_text().strip())
        assert event["output_summary"] == "2431 bytes"

    def test_emit_thread_safety(self, tmp_path):
        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))
        errors = []

        def emit_n(n):
            try:
                for i in range(n):
                    emitter.emit(
                        type="command_complete",
                        tool="shell",
                        input_summary=f"cmd-{threading.current_thread().name}-{i}",
                        output_summary="exit 0, 0 bytes stdout",
                        duration_ms=1,
                        success=True,
                    )
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=emit_n, args=(10,)) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Threads raised errors: {errors}"
        lines = log_path.read_text().strip().split("\n")
        assert len(lines) == 100
        # Every line must be valid JSON
        for line in lines:
            event = json.loads(line)
            assert "id" in event
            assert "timestamp" in event

    def test_emit_creates_directory(self, tmp_path):
        log_path = tmp_path / "nested" / "deep" / "events.jsonl"
        emitter = EventEmitter(str(log_path))

        emitter.emit(
            type="health_check",
            tool="health",
            input_summary="health_check",
            output_summary="cpu=12%, mem=45%, disk=23%",
            duration_ms=5,
            success=True,
        )

        assert log_path.exists()
        event = json.loads(log_path.read_text().strip())
        assert event["type"] == "health_check"

    def test_init_creates_empty_file_for_tail(self, tmp_path):
        """EventEmitter.__init__ must touch the log file so `tail -f` can
        open it immediately on a freshly started agent with no events yet."""
        log_path = tmp_path / "events.jsonl"
        assert not log_path.exists()

        EventEmitter(str(log_path))

        assert log_path.exists()
        assert log_path.read_text() == ""  # empty, not corrupted

    def test_init_does_not_truncate_existing_file(self, tmp_path):
        """If the file already has events (agent restart), init must not erase them."""
        log_path = tmp_path / "events.jsonl"
        existing_line = '{"id":"old","type":"command_complete"}\n'
        log_path.write_text(existing_line)

        EventEmitter(str(log_path))

        assert log_path.read_text() == existing_line  # preserved

    def test_emit_correlation_id_top_level(self, tmp_path):
        """AI-171: correlation_id is written as a top-level field for SSE filtering."""
        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))

        emitter.emit(
            type="chat_inference_start",
            tool="chat",
            input_summary="thread=t1 model=gpt-4o-mini",
            output_summary=None,
            duration_ms=None,
            success=None,
            correlation_id="msg-uuid-123",
            metadata={"work_id": "w1"},
        )

        event = json.loads(log_path.read_text().strip())
        assert event["correlation_id"] == "msg-uuid-123"
        assert event["metadata"]["work_id"] == "w1"

    def test_emit_no_correlation_id_when_none(self, tmp_path):
        """correlation_id field is omitted (not null) when not provided."""
        log_path = tmp_path / "events.jsonl"
        emitter = EventEmitter(str(log_path))

        emitter.emit(
            type="command_start",
            tool="shell",
            input_summary="ls",
            output_summary=None,
            duration_ms=None,
            success=None,
        )

        event = json.loads(log_path.read_text().strip())
        assert "correlation_id" not in event
