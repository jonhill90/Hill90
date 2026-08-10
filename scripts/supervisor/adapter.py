"""Harness-specific tmux adapters for the portable supervisor ledger."""

from __future__ import annotations

import re
import time
from pathlib import Path


BLOCKED_RE = re.compile(r"hit your (?:weekly |usage )?limit|usage limit", re.IGNORECASE)
APPROVAL_RE = re.compile(r"\[Y/n\]|\(y/N\)|(?:Allow|Approve|Continue|Proceed).*[?]", re.IGNORECASE)
CODEX_ACTIVE_RE = re.compile(r"^[•◦]\s+(?:Working|Running|Thinking)(?:\s|\()", re.MULTILINE)
CLAUDE_ACTIVE_RE = re.compile(
    r"^✻\s+(?!(?:Crunched|Cooked|Worked|Brewed)\b)(?:Thinking|Churning|Working|Running|[A-Za-z]+ing)(?:…|\.{3}|\s|$)",
    re.MULTILINE,
)


def classify_capture(harness, capture):
    tail = "\n".join(capture.splitlines()[-25:])
    if BLOCKED_RE.search(tail):
        return "blocked"
    if APPROVAL_RE.search(tail):
        return "approval"
    if harness == "codex":
        if CODEX_ACTIVE_RE.search(tail):
            return "active"
        if any(line.startswith("›") for line in tail.splitlines()[-5:]):
            return "idle"
    elif harness == "claude":
        if CLAUDE_ACTIVE_RE.search(tail):
            return "active"
        if any(line.lstrip().startswith("❯") for line in tail.splitlines()[-5:]):
            return "idle"
    else:
        raise ValueError(f"unsupported harness: {harness}")
    return "unknown"


class TmuxAdapter:
    NONCE_OPTION = "@hill90_lane_nonce"
    LANE_OPTION = "@hill90_lane"

    def __init__(self, ledger, transport, *, clock=None):
        self.ledger = ledger
        self.transport = transport
        self.clock = clock or time.time

    @staticmethod
    def _command_matches(harness, command):
        if harness == "codex":
            return command == "codex"
        if harness == "claude":
            return command in ("claude", "claude.exe")
        return False

    def register_lane(self, *, lane, target, harness, repo, nonce):
        metadata = self.transport.metadata(target)
        if metadata["path"] != repo:
            raise RuntimeError(f"lane repo mismatch: {metadata['path']}")
        if not self._command_matches(harness, metadata["command"]):
            raise RuntimeError(f"lane harness mismatch: {metadata['command']}")
        self.transport.set_option(target, self.NONCE_OPTION, nonce)
        self.transport.set_option(target, self.LANE_OPTION, lane)
        return self.ledger.register_lane(
            lane=lane,
            pane_id=metadata["pane_id"],
            nonce=nonce,
            harness=harness,
            repo=repo,
            server_id=metadata["server_id"],
            session_id=metadata["session_id"],
            command=metadata["command"],
        )

    def _verified_lane(self, lane):
        record = self.ledger.get_lane(lane)
        if record is None:
            raise RuntimeError(f"unknown lane: {lane}")
        metadata = self.transport.metadata(record["pane_id"])
        identity = (
            metadata["pane_id"] == record["pane_id"]
            and metadata["path"] == record["repo"]
            and metadata["server_id"] == record["server_id"]
            and metadata["session_id"] == record["session_id"]
            and self._command_matches(record["harness"], metadata["command"])
            and self.transport.get_option(record["pane_id"], self.NONCE_OPTION) == record["nonce"]
            and self.transport.get_option(record["pane_id"], self.LANE_OPTION) == lane
        )
        if not identity:
            raise RuntimeError("pane incarnation does not match registered lane")
        return record

    def assign_task(self, *, lane, task_id, summary):
        with self.ledger.operation_lock():
            record = self._verified_lane(lane)
            existing = self.ledger.get_task(task_id)
            if existing is not None and existing["status"] == "delivery_pending":
                raise RuntimeError(
                    f"delivery already attempted for task {task_id} and is unconfirmed; "
                    "reconcile the task before it can be assigned again"
                )
            state = classify_capture(record["harness"], self.transport.capture(record["pane_id"], lines=25))
            if state != "idle":
                raise RuntimeError(f"lane is {state}; assignment not sent")

            task = self.ledger.assign(
                task_id=task_id,
                lane=lane,
                pane_nonce=record["nonce"],
                summary=summary,
            )
            incoming = self.ledger.root / "incoming"
            incoming.mkdir(mode=0o700, exist_ok=True)
            result_file = incoming / f"{task_id}.md"
            prompt = (
                f"[Hill90 task {task_id}] {summary}\n\n"
                "Do not begin unrelated work. Record commands and actual outputs in a compact result. "
                f"Before working run: hill90-supervisor accept --task {task_id}. "
                f"At completion write {result_file} and run: "
                f"hill90-supervisor complete --task {task_id} --result-file {result_file}"
            )
            # Persist the ambiguous, non-resendable state before the physical
            # send. If send_literal raises, or the ledger write below fails,
            # the task is left here rather than silently eligible for retry -
            # see assign_task's guard above and mark_delivered's own allowed
            # source state. Nothing after this point trusts echoed pane text
            # to decide whether the send actually reached the harness.
            self.ledger.mark_delivery_pending(task_id, pane_nonce=record["nonce"])
            self.transport.send_literal(record["pane_id"], prompt)
            return self.ledger.mark_delivered(task_id, pane_nonce=record["nonce"])

    def observe_lane(self, lane):
        record = self._verified_lane(lane)
        state = classify_capture(record["harness"], self.transport.capture(record["pane_id"], lines=25))
        if state == "idle":
            return self.ledger.observe_idle(lane, pane_nonce=record["nonce"])
        return None

    def notify_architecture(self, *, lane, retry_after):
        with self.ledger.operation_lock():
            record = self._verified_lane(lane)
            pre_state = classify_capture(record["harness"], self.transport.capture(record["pane_id"], lines=25))
            if pre_state != "idle":
                return False
            events = self.ledger.events_due()
            if not events:
                return False
            event_lines = []
            for event in events:
                detail = event["key"]
                if event["payload_path"]:
                    detail += f" result={event['payload_path']}"
                event_lines.append(detail)
            keys = [event["key"] for event in events]
            prompt = (
                "Hill90 supervisor events:\n- "
                + "\n- ".join(event_lines)
                + "\nRead only these event artifacts, verify evidence, continue bounded work, then acknowledge with: "
                + "hill90-supervisor ack --event "
                + " --event ".join(keys)
            )
            self.transport.send_literal(record["pane_id"], prompt)
            post_state = classify_capture(record["harness"], self.transport.capture(record["pane_id"], lines=25))
            if post_state != "active":
                return False
            self.ledger.mark_notified(keys, retry_after=retry_after)
            return True
