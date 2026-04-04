"""Terminal JSONL logger — writes PTY output to a structured log file.

Each line in the log is a JSON object with a monotonic sequence number,
timestamp, event type, and base64-encoded output data. This file is
consumed by `tail -f` from the API service for SSE streaming.
"""

from __future__ import annotations

import base64
import json
import os
import shlex
import threading
import time
from datetime import datetime, timezone

from app.events import EventEmitter
from app.pty_shell import PtyResult, execute_streaming

# Buffering: coalesce output for up to 200ms, flush on newline or 8KB
COALESCE_MS = 200
FLUSH_SIZE = 8192


class TerminalLogger:
    """Writes PTY output to a JSONL file with sequence-based cursor support."""

    def __init__(self, log_dir: str) -> None:
        self._log_path = os.path.join(log_dir, "terminal.jsonl")
        self._lock = threading.Lock()
        self._seq = 0
        os.makedirs(log_dir, exist_ok=True)
        # Touch file for tail -f
        if not os.path.exists(self._log_path):
            open(self._log_path, "a").close()

    def _write_event(self, event: dict) -> None:
        """Write a single JSON line to the terminal log."""
        line = json.dumps(event, separators=(",", ":")) + "\n"
        with self._lock:
            with open(self._log_path, "a") as f:
                f.write(line)
                f.flush()

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def _now(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def reset(self) -> None:
        """Reset sequence counter and truncate log for new command."""
        with self._lock:
            self._seq = 0
            with open(self._log_path, "w") as f:
                f.truncate(0)

    def execute_and_log(
        self,
        command: str,
        argv: list[str],
        env: dict[str, str],
        cwd: str,
        timeout: int,
        command_id: str,
        emitter: EventEmitter | None = None,
        work_id: str | None = None,
    ) -> dict:
        """Execute command via PTY, log output to terminal.jsonl.

        Returns dict compatible with existing shell result format:
        { success, exit_code, stdout (truncated), stderr }
        """
        self.reset()

        # Emit command_start
        self._write_event({
            "seq": self._next_seq(),
            "ts": self._now(),
            "type": "command_start",
            "command_id": command_id,
            "command": command,
        })

        if emitter:
            meta: dict[str, str] = {"command_id": command_id}
            if work_id:
                meta["work_id"] = work_id
            emitter.emit(
                type="command_start",
                tool="shell",
                input_summary=command,
                output_summary=None,
                duration_ms=None,
                success=None,
                metadata=meta,
            )

        t0 = time.monotonic()
        stdout_parts: list[str] = []
        buffer = b""
        last_flush = time.monotonic()

        gen = execute_streaming(argv, env, cwd=cwd, timeout=timeout)
        result: PtyResult | None = None

        try:
            while True:
                try:
                    chunk = next(gen)
                except StopIteration as e:
                    result = e.value
                    break

                buffer += chunk
                now = time.monotonic()
                should_flush = (
                    b"\n" in buffer
                    or len(buffer) >= FLUSH_SIZE
                    or (now - last_flush) * 1000 >= COALESCE_MS
                )

                if should_flush and buffer:
                    encoded = base64.b64encode(buffer).decode("ascii")
                    self._write_event({
                        "seq": self._next_seq(),
                        "ts": self._now(),
                        "type": "output",
                        "command_id": command_id,
                        "data": encoded,
                    })
                    try:
                        stdout_parts.append(buffer.decode("utf-8", errors="replace"))
                    except Exception:
                        pass
                    buffer = b""
                    last_flush = now
        except Exception:
            if result is None:
                result = PtyResult(exit_code=-1, timed_out=False)

        # Flush remaining buffer
        if buffer:
            encoded = base64.b64encode(buffer).decode("ascii")
            self._write_event({
                "seq": self._next_seq(),
                "ts": self._now(),
                "type": "output",
                "command_id": command_id,
                "data": encoded,
            })
            try:
                stdout_parts.append(buffer.decode("utf-8", errors="replace"))
            except Exception:
                pass

        if result is None:
            result = PtyResult(exit_code=-1, timed_out=False)

        duration_ms = int((time.monotonic() - t0) * 1000)

        # Emit command_exit
        self._write_event({
            "seq": self._next_seq(),
            "ts": self._now(),
            "type": "command_exit",
            "command_id": command_id,
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
        })

        stdout_text = "".join(stdout_parts)[:100_000]

        if emitter:
            meta = {"command_id": command_id}
            if work_id:
                meta["work_id"] = work_id
            emitter.emit(
                type="command_complete",
                tool="shell",
                input_summary=command,
                output_summary=f"exit {result.exit_code}, {len(stdout_text)} bytes stdout",
                duration_ms=duration_ms,
                success=result.exit_code == 0 and not result.timed_out,
                metadata=meta,
            )

        if result.timed_out:
            return {"success": False, "error": f"Timed out after {timeout}s"}

        return {
            "success": result.exit_code == 0,
            "exit_code": result.exit_code,
            "stdout": stdout_text,
            "stderr": "",
        }
