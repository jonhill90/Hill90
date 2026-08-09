"""Transactional task/event ledger for the Hill90 supervisor.

The core deliberately knows nothing about Codex, Claude terminal chrome, tmux
keystrokes, or GitHub. Harness adapters register pane incarnations and move
tasks through this shared lifecycle.
"""

from __future__ import annotations

import contextlib
import difflib
import fcntl
import hashlib
import os
import re
import sqlite3
import tempfile
import time
from pathlib import Path


TERMINAL_STATUSES = ("complete", "failed", "cancelled")
TASK_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
COMPONENT_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
MAX_RESULT_BYTES = 64 * 1024


class Ledger:
    def __init__(self, root: Path | str, *, clock=None):
        self.root = Path(root)
        self.clock = clock or (lambda: int(time.time()))
        self.results_dir = self.root / "results"
        self.snapshots_dir = self.root / "snapshots"
        self.event_payloads_dir = self.root / "event-payloads"
        self.db_path = self.root / "ledger.sqlite3"
        self.lock_path = self.root / "ledger.lock"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.results_dir.mkdir(exist_ok=True, mode=0o700)
        os.chmod(self.results_dir, 0o700)
        self.snapshots_dir.mkdir(exist_ok=True, mode=0o700)
        self.event_payloads_dir.mkdir(exist_ok=True, mode=0o700)
        os.chmod(self.snapshots_dir, 0o700)
        os.chmod(self.event_payloads_dir, 0o700)
        self.lock_path.touch(mode=0o600, exist_ok=True)
        os.chmod(self.lock_path, 0o600)
        self._lock_depth = 0
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        return connection

    @contextlib.contextmanager
    def _locked(self):
        if self._lock_depth:
            self._lock_depth += 1
            try:
                yield
            finally:
                self._lock_depth -= 1
            return
        with self.lock_path.open("r+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            self._lock_depth = 1
            try:
                yield
            finally:
                self._lock_depth = 0
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def operation_lock(self):
        """Hold the ledger lock across adapter I/O and state transitions."""
        return self._locked()

    @contextlib.contextmanager
    def _transaction(self):
        connection = self._connect()
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()
        finally:
            connection.close()

    def _initialize(self):
        with self._locked(), self._transaction() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS lanes (
                    lane TEXT PRIMARY KEY,
                    pane_id TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    harness TEXT NOT NULL CHECK (harness IN ('codex', 'claude')),
                    repo TEXT NOT NULL,
                    server_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    command TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    lane TEXT NOT NULL REFERENCES lanes(lane),
                    pane_nonce TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('created', 'delivered', 'accepted', 'running',
                                   'complete', 'failed', 'cancelled')
                    ),
                    result_path TEXT,
                    result_sha256 TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    delivered_at INTEGER,
                    accepted_at INTEGER,
                    completed_at INTEGER
                );

                CREATE UNIQUE INDEX IF NOT EXISTS one_open_task_per_lane
                    ON tasks(lane)
                    WHERE status NOT IN ('complete', 'failed', 'cancelled');

                CREATE TABLE IF NOT EXISTS events (
                    key TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    task_id TEXT REFERENCES tasks(id),
                    status TEXT NOT NULL CHECK (status IN ('pending', 'notified', 'acked')),
                    payload_path TEXT,
                    created_at INTEGER NOT NULL,
                    notified_at INTEGER,
                    retry_at INTEGER,
                    acked_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS components (
                    name TEXT PRIMARY KEY,
                    healthy INTEGER NOT NULL,
                    error TEXT,
                    snapshot_sha256 TEXT,
                    updated_at INTEGER NOT NULL
                );
                """
            )
        os.chmod(self.db_path, 0o600)

    @staticmethod
    def _dict(row):
        return dict(row) if row is not None else None

    @staticmethod
    def _require_task_id(task_id):
        if not TASK_ID_RE.fullmatch(task_id):
            raise ValueError("invalid task id")

    @staticmethod
    def _verify_lane_nonce(connection, lane, pane_nonce):
        row = connection.execute("SELECT nonce FROM lanes WHERE lane = ?", (lane,)).fetchone()
        if row is None:
            raise ValueError(f"unknown lane: {lane}")
        if row["nonce"] != pane_nonce:
            raise ValueError("pane incarnation does not match registered lane")

    def register_lane(self, *, lane, pane_id, nonce, harness, repo, server_id, session_id, command):
        if harness not in ("codex", "claude"):
            raise ValueError("unsupported harness")
        if not all((lane, pane_id, nonce, repo, server_id, session_id, command)):
            raise ValueError("lane registration fields must be non-empty")
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO lanes(lane, pane_id, nonce, harness, repo, server_id,
                                  session_id, command, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(lane) DO UPDATE SET
                    pane_id=excluded.pane_id,
                    nonce=excluded.nonce,
                    harness=excluded.harness,
                    repo=excluded.repo,
                    server_id=excluded.server_id,
                    session_id=excluded.session_id,
                    command=excluded.command,
                    updated_at=excluded.updated_at
                """,
                (lane, pane_id, nonce, harness, repo, server_id, session_id, command, now),
            )
            row = connection.execute("SELECT * FROM lanes WHERE lane = ?", (lane,)).fetchone()
        return self._dict(row)

    def get_lane(self, lane):
        with contextlib.closing(self._connect()) as connection:
            return self._dict(connection.execute("SELECT * FROM lanes WHERE lane = ?", (lane,)).fetchone())

    def list_lanes(self):
        with contextlib.closing(self._connect()) as connection:
            rows = connection.execute("SELECT * FROM lanes ORDER BY lane").fetchall()
        return [self._dict(row) for row in rows]

    def get_task(self, task_id):
        with contextlib.closing(self._connect()) as connection:
            return self._dict(connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())

    def list_tasks(self):
        with contextlib.closing(self._connect()) as connection:
            rows = connection.execute("SELECT * FROM tasks ORDER BY created_at, id").fetchall()
        return [self._dict(row) for row in rows]

    def assign(self, *, task_id, lane, pane_nonce, summary):
        self._require_task_id(task_id)
        if not summary.strip():
            raise ValueError("task summary must be non-empty")
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            self._verify_lane_nonce(connection, lane, pane_nonce)
            existing = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if existing is not None:
                if existing["lane"] == lane and existing["pane_nonce"] == pane_nonce and existing["summary"] == summary:
                    return self._dict(existing)
                raise ValueError("task id already exists with different assignment")
            try:
                connection.execute(
                    """
                    INSERT INTO tasks(id, lane, pane_nonce, summary, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'created', ?, ?)
                    """,
                    (task_id, lane, pane_nonce, summary, now, now),
                )
            except sqlite3.IntegrityError as error:
                if "tasks.lane" in str(error):
                    raise ValueError(f"lane has an outstanding task: {lane}") from error
                raise
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._dict(row)

    def _transition(self, task_id, pane_nonce, allowed, target, timestamp_column):
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise ValueError("unknown task")
            self._verify_lane_nonce(connection, row["lane"], pane_nonce)
            if row["pane_nonce"] != pane_nonce:
                raise ValueError("pane incarnation does not match task")
            if row["status"] == target:
                return self._dict(row)
            if row["status"] not in allowed:
                raise ValueError(f"cannot transition task from {row['status']} to {target}")
            connection.execute(
                f"UPDATE tasks SET status = ?, updated_at = ?, {timestamp_column} = ? WHERE id = ?",
                (target, now, now, task_id),
            )
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._dict(row)

    def mark_delivered(self, task_id, *, pane_nonce):
        return self._transition(task_id, pane_nonce, ("created",), "delivered", "delivered_at")

    def accept(self, task_id, *, pane_nonce):
        return self._transition(task_id, pane_nonce, ("delivered",), "accepted", "accepted_at")

    def cancel_open_task(self, lane):
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM tasks WHERE lane = ? AND status NOT IN ('complete','failed','cancelled')",
                (lane,),
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE tasks SET status='cancelled', updated_at=?, completed_at=? WHERE id=?",
                (now, now, row["id"]),
            )
            return self._dict(connection.execute("SELECT * FROM tasks WHERE id=?", (row["id"],)).fetchone())

    def _write_result(self, task_id, result):
        if not isinstance(result, bytes):
            raise TypeError("result must be bytes")
        if not result.strip():
            raise ValueError("result must be non-empty")
        if len(result) > MAX_RESULT_BYTES:
            raise ValueError("result exceeds 64 KiB limit")
        digest = hashlib.sha256(result).hexdigest()
        destination = self.results_dir / f"{task_id}.md"
        if destination.exists():
            if hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
                raise ValueError("immutable result conflicts with existing content")
            return destination, digest
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{task_id}.", dir=self.results_dir)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(result)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_name, 0o600)
            try:
                os.link(temporary_name, destination)
            except FileExistsError:
                if hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
                    raise ValueError("immutable result conflicts with concurrent content")
            os.chmod(destination, 0o600)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary_name)
        return destination, digest

    @staticmethod
    def _fail(failpoint, expected):
        if failpoint == expected:
            raise RuntimeError(expected)

    def complete(self, task_id, result, *, failpoint=None):
        self._require_task_id(task_id)
        with self._locked():
            destination, digest = self._write_result(task_id, result)
            self._fail(failpoint, "after_result")
            now = int(self.clock())
            with self._transaction() as connection:
                row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
                if row is None:
                    raise ValueError("unknown task")
                if row["status"] == "complete":
                    if row["result_sha256"] != digest:
                        raise ValueError("immutable result conflicts with completed task")
                    return self._dict(row)
                if row["status"] in ("failed", "cancelled"):
                    raise ValueError(f"cannot complete {row['status']} task")
                connection.execute(
                    """
                    UPDATE tasks SET status='complete', result_path=?, result_sha256=?,
                                     updated_at=?, completed_at=? WHERE id=?
                    """,
                    (str(destination), digest, now, now, task_id),
                )
                self._fail(failpoint, "after_task")
                connection.execute(
                    """
                    INSERT OR IGNORE INTO events(key, type, task_id, status, payload_path, created_at)
                    VALUES (?, 'completion', ?, 'pending', ?, ?)
                    """,
                    (f"completion:{task_id}", task_id, str(destination), now),
                )
                self._fail(failpoint, "after_event")
                row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return self._dict(row)

    def observe_idle(self, lane, *, pane_nonce):
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            self._verify_lane_nonce(connection, lane, pane_nonce)
            task = connection.execute(
                """
                SELECT * FROM tasks WHERE lane=?
                  AND status IN ('delivered','accepted','running')
                """,
                (lane,),
            ).fetchone()
            if task is None:
                return None
            key = f"attention:{task['id']}"
            connection.execute(
                """
                INSERT OR IGNORE INTO events(key, type, task_id, status, created_at)
                VALUES (?, 'attention', ?, 'pending', ?)
                """,
                (key, task["id"], now),
            )
            event = connection.execute("SELECT * FROM events WHERE key=?", (key,)).fetchone()
        return self._dict(event)

    def list_events(self, *, task_id=None, event_type=None):
        clauses = []
        values = []
        if task_id is not None:
            clauses.append("task_id = ?")
            values.append(task_id)
        if event_type is not None:
            clauses.append("type = ?")
            values.append(event_type)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with contextlib.closing(self._connect()) as connection:
            rows = connection.execute(f"SELECT * FROM events{where} ORDER BY created_at, key", values).fetchall()
        return [self._dict(row) for row in rows]

    def get_event(self, key):
        with contextlib.closing(self._connect()) as connection:
            return self._dict(connection.execute("SELECT * FROM events WHERE key=?", (key,)).fetchone())

    def events_due(self, *, now=None):
        now = int(self.clock() if now is None else now)
        with contextlib.closing(self._connect()) as connection:
            rows = connection.execute(
                """
                SELECT * FROM events
                 WHERE status='pending'
                    OR (status='notified' AND retry_at IS NOT NULL AND retry_at <= ?)
                 ORDER BY created_at, key
                """,
                (now,),
            ).fetchall()
        return [self._dict(row) for row in rows]

    def mark_notified(self, keys, *, retry_after):
        now = int(self.clock())
        retry_at = now + int(retry_after)
        with self._locked(), self._transaction() as connection:
            for key in keys:
                if connection.execute("SELECT 1 FROM events WHERE key=?", (key,)).fetchone() is None:
                    raise ValueError(f"unknown event: {key}")
                connection.execute(
                    "UPDATE events SET status='notified', notified_at=?, retry_at=? WHERE key=? AND status!='acked'",
                    (now, retry_at, key),
                )

    def ack(self, keys):
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            for key in keys:
                event = connection.execute("SELECT * FROM events WHERE key=?", (key,)).fetchone()
                if event is None:
                    raise ValueError(f"unknown event: {key}")
                if event["type"] == "attention":
                    task = connection.execute("SELECT status FROM tasks WHERE id=?", (event["task_id"],)).fetchone()
                    if task is not None and task["status"] not in TERMINAL_STATUSES:
                        raise ValueError("attention requires task disposition before acknowledgement")
                connection.execute(
                    "UPDATE events SET status='acked', acked_at=?, retry_at=NULL WHERE key=?",
                    (now, key),
                )

    def record_component(self, name, *, healthy, snapshot=None, error=None):
        if healthy and snapshot is None:
            raise ValueError("healthy component requires a snapshot")
        if not healthy and not error:
            raise ValueError("failed component requires an error")
        now = int(self.clock())
        with self._locked(), self._transaction() as connection:
            existing = connection.execute("SELECT * FROM components WHERE name=?", (name,)).fetchone()
            digest = hashlib.sha256(snapshot).hexdigest() if healthy else (existing["snapshot_sha256"] if existing else None)
            connection.execute(
                """
                INSERT INTO components(name, healthy, error, snapshot_sha256, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    healthy=excluded.healthy,
                    error=excluded.error,
                    snapshot_sha256=excluded.snapshot_sha256,
                    updated_at=excluded.updated_at
                """,
                (name, int(healthy), None if healthy else error, digest, now),
            )
            row = connection.execute("SELECT * FROM components WHERE name=?", (name,)).fetchone()
        return self._dict(row)

    @staticmethod
    def _atomic_replace(destination, content):
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, destination)
            os.chmod(destination, 0o600)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary_name)

    def record_snapshot(self, name, snapshot):
        """Record a healthy component snapshot and emit one bounded diff event."""
        if not COMPONENT_RE.fullmatch(name):
            raise ValueError("invalid component name")
        if not isinstance(snapshot, bytes):
            raise TypeError("snapshot must be bytes")
        digest = hashlib.sha256(snapshot).hexdigest()
        baseline_path = self.snapshots_dir / f"{name}.txt"
        with self._locked():
            if not baseline_path.exists():
                self.record_component(name, snapshot=snapshot, healthy=True)
                self._atomic_replace(baseline_path, snapshot)
                return None
            previous = baseline_path.read_bytes()
            if previous == snapshot:
                self.record_component(name, snapshot=snapshot, healthy=True)
                return None

            old_text = previous.decode("utf-8", errors="replace").splitlines(keepends=True)
            new_text = snapshot.decode("utf-8", errors="replace").splitlines(keepends=True)
            diff = "".join(
                difflib.unified_diff(old_text, new_text, fromfile=f"{name}:previous", tofile=f"{name}:{digest}")
            ).encode()
            marker = b"\n[DIFF TRUNCATED]\n"
            if len(diff) > MAX_RESULT_BYTES:
                diff = diff[: MAX_RESULT_BYTES - len(marker)] + marker
            payload_path = self.event_payloads_dir / f"{name}-{digest}.diff"
            if payload_path.exists():
                if payload_path.read_bytes() != diff:
                    raise ValueError("sensor event payload conflicts with existing content")
            else:
                self._atomic_replace(payload_path, diff)

            now = int(self.clock())
            key = f"sensor:{name}:{digest}"
            with self._transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO components(name, healthy, error, snapshot_sha256, updated_at)
                    VALUES (?, 1, NULL, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET
                        healthy=1, error=NULL, snapshot_sha256=excluded.snapshot_sha256,
                        updated_at=excluded.updated_at
                    """,
                    (name, digest, now),
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO events(key, type, status, payload_path, created_at)
                    VALUES (?, 'sensor', 'pending', ?, ?)
                    """,
                    (key, str(payload_path), now),
                )
                event = connection.execute("SELECT * FROM events WHERE key=?", (key,)).fetchone()
            self._atomic_replace(baseline_path, snapshot)
        return self._dict(event)
