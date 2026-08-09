"""GitHub-backed task records for the supervisor's replaceable local spool.

GitHub Issues and pull requests contain the authoritative task declaration and
append-only status evidence.  This module deliberately treats SQLite as a
delivery cache: deleting the state directory and reconstructing it from the
same source records must produce the same task facts.
"""

from __future__ import annotations

import json
import re
import subprocess


MARKER_PREFIX = "<!-- hill90-supervisor:v1 "
MARKER_RE = re.compile(
    r"<!-- hill90-supervisor:v1 (?P<payload>\{.*?\}) -->", re.DOTALL
)
SOURCE_REF_RE = re.compile(r"^[0-9a-f]{40,64}$")
SOURCE_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/"
    r"(?P<repo>[A-Za-z0-9_.-]+)/(?P<kind>issues|pull)/(?P<number>[1-9][0-9]*)$"
)
STATUSES = frozenset(("created", "delivered", "accepted", "running", "complete", "failed", "cancelled"))
TERMINAL_STATUSES = frozenset(("complete", "failed", "cancelled"))


def subprocess_runner(command):
    """Run gh without a shell so task data cannot become executable input."""
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def marker(fields):
    """Render a stable, machine-readable GitHub marker.

    Callers store this verbatim in an Issue/PR body (``kind=task``) or a
    comment (``kind=status``).  Sorted compact JSON makes the marker a
    deterministic receipt for its fields.
    """
    return MARKER_PREFIX + json.dumps(fields, sort_keys=True, separators=(",", ":")) + " -->"


def _parse_source_url(source_url):
    if not isinstance(source_url, str):
        raise ValueError("source URL must be a GitHub Issue or PR URL")
    match = SOURCE_URL_RE.fullmatch(source_url)
    if match is None:
        raise ValueError("source URL must be a canonical GitHub Issue or PR URL")
    value = match.groupdict()
    value["source_kind"] = "issue" if value.pop("kind") == "issues" else "pull"
    return value


def _task_id(parts):
    return f"gh.{parts['owner']}.{parts['repo']}.{parts['source_kind']}.{parts['number']}"


def _markers(text):
    if not isinstance(text, str):
        return []
    values = []
    for found in MARKER_RE.finditer(text):
        try:
            value = json.loads(found.group("payload"))
        except json.JSONDecodeError as error:
            raise ValueError("invalid hill90-supervisor marker JSON") from error
        if not isinstance(value, dict):
            raise ValueError("hill90-supervisor marker must be an object")
        values.append((found.group(0), value))
    return values


class GithubTaskSource:
    """Read authoritative task state through an injectable, mockable gh runner."""

    def __init__(self, runner=None):
        self.runner = runner or subprocess_runner

    @staticmethod
    def _require_ref(source_ref):
        if not isinstance(source_ref, str) or not SOURCE_REF_RE.fullmatch(source_ref):
            raise ValueError("source ref must be an immutable commit SHA")

    @staticmethod
    def _validate_binding(fields, *, source_url, source_ref, task_id, kind):
        required = {
            "source_url": source_url,
            "source_ref": source_ref,
            "task_id": task_id,
        }
        for name, expected in required.items():
            if fields.get(name) != expected:
                label = "task marker" if kind == "task" else "status marker"
                if name == "source_url":
                    raise ValueError(f"{label} source URL does not match GitHub source")
                raise ValueError(f"{label} {name.replace('_', ' ')} does not match GitHub source")

    def _view(self, parts):
        command = [
            "gh",
            "issue" if parts["source_kind"] == "issue" else "pr",
            "view",
            parts["number"],
            "--repo",
            f"{parts['owner']}/{parts['repo']}",
            "--json",
            "number,url,title,body,state,comments"
            + (",headRefOid" if parts["source_kind"] == "pull" else ""),
        ]
        try:
            payload = json.loads(self.runner(command))
        except json.JSONDecodeError as error:
            raise ValueError("gh returned invalid GitHub task JSON") from error
        if not isinstance(payload, dict):
            raise ValueError("gh returned invalid GitHub task JSON")
        return payload

    def _verify_ref(self, parts, source_ref):
        resolved = self.runner(
            [
                "gh",
                "api",
                f"repos/{parts['owner']}/{parts['repo']}/commits/{source_ref}",
                "--jq",
                ".sha",
            ]
        ).strip()
        if resolved != source_ref:
            raise ValueError("GitHub did not resolve the required immutable source ref")

    def load(self, *, source_url, source_ref):
        """Load one Issue/PR and validate its task declaration and receipts."""
        parts = _parse_source_url(source_url)
        self._require_ref(source_ref)
        payload = self._view(parts)
        if payload.get("url") != source_url:
            raise ValueError("GitHub returned a different canonical source URL")
        if str(payload.get("number")) != parts["number"]:
            raise ValueError("GitHub returned a different source number")
        if parts["source_kind"] == "pull" and payload.get("headRefOid") != source_ref:
            raise ValueError("pull request head ref does not match required immutable source ref")
        self._verify_ref(parts, source_ref)

        task_id = _task_id(parts)
        declarations = [(raw, value) for raw, value in _markers(payload.get("body", "")) if value.get("kind") == "task"]
        if len(declarations) != 1:
            raise ValueError("GitHub task body must contain exactly one task marker")
        _raw_task_marker, declaration = declarations[0]
        self._validate_binding(
            declaration, source_url=source_url, source_ref=source_ref, task_id=task_id, kind="task"
        )

        receipts = []
        for comment in payload.get("comments", []):
            if not isinstance(comment, dict) or not isinstance(comment.get("createdAt"), str):
                raise ValueError("GitHub task comments must include creation timestamps")
            for raw, value in _markers(comment.get("body", "")):
                if value.get("kind") != "status":
                    continue
                self._validate_binding(
                    value, source_url=source_url, source_ref=source_ref, task_id=task_id, kind="status"
                )
                status = value.get("status")
                if status not in STATUSES:
                    raise ValueError("status marker contains an unsupported task status")
                evidence = value.get("evidence")
                if not isinstance(evidence, list) or not all(isinstance(item, str) and item for item in evidence):
                    raise ValueError("status marker evidence must be a list of non-empty strings")
                if status in TERMINAL_STATUSES and not evidence:
                    raise ValueError("terminal status requires evidence")
                receipts.append((comment["createdAt"], raw, value))

        receipts.sort(key=lambda receipt: receipt[0])
        if receipts:
            _created_at, status_marker, status_receipt = receipts[-1]
            status = status_receipt["status"]
            evidence = status_receipt["evidence"]
        else:
            status = "created"
            evidence = []
            status_marker = None
        return {
            "task_id": task_id,
            "source_kind": parts["source_kind"],
            "source_url": source_url,
            "source_ref": source_ref,
            "summary": payload.get("title", ""),
            "source_state": payload.get("state"),
            "status": status,
            "evidence": evidence,
            "status_marker": status_marker,
        }

    def reconstruct(self, spool, *, source_url, source_ref):
        """Rebuild local delivery state from an authoritative GitHub record."""
        record = self.load(source_url=source_url, source_ref=source_ref)
        return spool.reconstruct_task(**record)

    def publish_status(self, *, source_url, source_ref, status, evidence):
        """Append an immutable, deterministic status receipt to its GitHub task.

        The local ledger must call this before it treats a task transition as
        durable.  A terminal receipt cannot be made without an evidence value,
        so a bare SQLite transition can never become the only completion proof.
        """
        if status not in STATUSES:
            raise ValueError("status marker contains an unsupported task status")
        if not isinstance(evidence, list) or not all(isinstance(item, str) and item for item in evidence):
            raise ValueError("status marker evidence must be a list of non-empty strings")
        if status in TERMINAL_STATUSES and not evidence:
            raise ValueError("terminal status requires evidence")
        record = self.load(source_url=source_url, source_ref=source_ref)
        receipt = marker(
            {
                "evidence": evidence,
                "kind": "status",
                "source_ref": record["source_ref"],
                "source_url": record["source_url"],
                "status": status,
                "task_id": record["task_id"],
            }
        )
        parts = _parse_source_url(source_url)
        self.runner(
            [
                "gh",
                "issue" if parts["source_kind"] == "issue" else "pr",
                "comment",
                parts["number"],
                "--repo",
                f"{parts['owner']}/{parts['repo']}",
                "--body",
                receipt,
            ]
        )
        return receipt
