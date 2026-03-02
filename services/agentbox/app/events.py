"""Structured event emitter for agent runtime observability.

Writes JSONL events to a log file for each tool invocation.
Events contain metadata-only summaries — no raw stdout, file contents, or secrets.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone


class EventEmitter:
    """Append-only JSONL event writer with thread-safe file access."""

    def __init__(self, log_path: str) -> None:
        self._log_path = log_path
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(log_path), exist_ok=True)

    def emit(
        self,
        *,
        type: str,
        tool: str,
        input_summary: str,
        output_summary: str | None,
        duration_ms: int | None,
        success: bool | None,
        metadata: dict | None = None,
    ) -> None:
        """Write a single event as a JSON line to the log file.

        Args:
            type: Event type (e.g. command_start, file_read, health_check).
            tool: Tool category (shell, filesystem, identity, health).
            input_summary: Truncated human-readable input (max 200 chars).
            output_summary: Metadata-only result summary, or None for start events.
            duration_ms: Execution time in milliseconds, or None for start events.
            success: Whether the operation succeeded, or None for start events.
            metadata: Optional tool-specific extra data.
        """
        event = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "type": type,
            "tool": tool,
            "input_summary": self._truncate(input_summary, 200),
            "output_summary": output_summary,
            "duration_ms": duration_ms,
            "success": success,
        }
        if metadata:
            event["metadata"] = metadata

        line = json.dumps(event, separators=(",", ":")) + "\n"

        with self._lock:
            with open(self._log_path, "a") as f:
                f.write(line)
                f.flush()

    @staticmethod
    def _truncate(text: str | None, max_len: int) -> str | None:
        if text is None:
            return None
        if len(text) <= max_len:
            return text
        return text[:max_len]
