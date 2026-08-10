import hashlib
import concurrent.futures
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SUPERVISOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPERVISOR_DIR))

from core import Ledger  # noqa: E402


# The exact schema `_initialize` wrote at 3af0b431, before `delivery_pending`
# or `delivery_attempted_at` existed. `CREATE TABLE IF NOT EXISTS` never
# rewrites a table that already exists this way, so any ledger created under
# that commit needs `_migrate_tasks_table` to reach the current schema.
PRE_PR_SCHEMA_SCRIPT = """
CREATE TABLE lanes (
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

CREATE TABLE tasks (
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

CREATE UNIQUE INDEX one_open_task_per_lane
    ON tasks(lane)
    WHERE status NOT IN ('complete', 'failed', 'cancelled');

CREATE TABLE source_tasks (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('issue', 'pull')),
    source_url TEXT NOT NULL UNIQUE,
    source_ref TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_state TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('created', 'delivered', 'accepted', 'running',
                   'complete', 'failed', 'cancelled')
    ),
    evidence_json TEXT NOT NULL,
    status_marker TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE events (
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

CREATE TABLE components (
    name TEXT PRIMARY KEY,
    healthy INTEGER NOT NULL,
    error TEXT,
    snapshot_sha256 TEXT,
    updated_at INTEGER NOT NULL
);
"""


def _seed_pre_pr_database(root: Path):
    """Build a ledger.sqlite3 with exactly the 3af0b431 schema and one row."""
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "ledger.sqlite3"
    connection = sqlite3.connect(db_path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(PRE_PR_SCHEMA_SCRIPT)
        connection.execute(
            """
            INSERT INTO lanes(lane, pane_id, nonce, harness, repo, server_id, session_id, command, updated_at)
            VALUES ('app-review', '%22', 'nonce-22-a', 'codex', '/repo/app', 'server-a', '$4', 'codex', 1000)
            """
        )
        connection.execute(
            """
            INSERT INTO tasks(id, lane, pane_nonce, summary, status, created_at, updated_at)
            VALUES ('review-870', 'app-review', 'nonce-22-a', 'Review PR 870 without editing', 'created', 1000, 1000)
            """
        )
        connection.execute(
            """
            INSERT INTO events(key, type, task_id, status, created_at)
            VALUES ('attention:review-870', 'attention', 'review-870', 'pending', 1000)
            """
        )
        connection.commit()
    finally:
        connection.close()


class MutableClock:
    def __init__(self, value=1_000):
        self.value = value

    def __call__(self):
        return self.value


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.clock = MutableClock()
        self.ledger = Ledger(Path(self.tempdir.name), clock=self.clock)
        self.ledger.register_lane(
            lane="app-review",
            pane_id="%22",
            nonce="nonce-22-a",
            harness="codex",
            repo="/repo/app",
            server_id="server-a",
            session_id="$4",
            command="codex",
        )

    def assign(self, task_id="review-870"):
        return self.ledger.assign(
            task_id=task_id,
            lane="app-review",
            pane_nonce="nonce-22-a",
            summary="Review PR 870 without editing",
        )

    def test_one_nonterminal_task_per_lane_and_bound_acceptance(self):
        task = self.assign()
        self.assertEqual("created", task["status"])
        with self.assertRaisesRegex(ValueError, "outstanding task"):
            self.assign("review-871")

        self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.ledger.mark_delivered("review-870", pane_nonce="nonce-22-a")
        accepted = self.ledger.accept("review-870", pane_nonce="nonce-22-a")
        self.assertEqual("accepted", accepted["status"])
        with self.assertRaisesRegex(ValueError, "pane incarnation"):
            self.ledger.accept("review-870", pane_nonce="reused-pane")

    def test_delivery_pending_persists_before_send_and_blocks_direct_delivered(self):
        self.assign()
        with self.assertRaisesRegex(ValueError, "cannot transition"):
            self.ledger.mark_delivered("review-870", pane_nonce="nonce-22-a")

        pending = self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.assertEqual("delivery_pending", pending["status"])
        # Once ambiguous, it stays ambiguous until a transition names an outcome;
        # a second delivery attempt cannot be represented as a fresh "created" task.
        with self.assertRaisesRegex(ValueError, "outstanding task"):
            self.assign("review-871")

        delivered = self.ledger.mark_delivered("review-870", pane_nonce="nonce-22-a")
        self.assertEqual("delivered", delivered["status"])

    def test_reconcile_delivery_confirms_or_retires_an_ambiguous_task(self):
        self.assign()
        self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        with self.assertRaisesRegex(ValueError, "outcome"):
            self.ledger.reconcile_delivery("review-870", pane_nonce="nonce-22-a", outcome="bogus")

        confirmed = self.ledger.reconcile_delivery("review-870", pane_nonce="nonce-22-a", outcome="delivered")
        self.assertEqual("delivered", confirmed["status"])

        self.ledger.cancel_open_task("app-review")
        self.assign("review-871")
        self.ledger.mark_delivery_pending("review-871", pane_nonce="nonce-22-a")
        retired = self.ledger.reconcile_delivery("review-871", pane_nonce="nonce-22-a", outcome="failed")
        self.assertEqual("failed", retired["status"])
        # A retired ambiguous task frees the lane for a genuinely new assignment.
        self.assign("review-872")

    def test_completion_is_immutable_idempotent_and_event_is_exactly_once(self):
        self.assign()
        result = b"# Result\n\nNo findings.\n"
        completed = self.ledger.complete("review-870", result)
        self.assertEqual("complete", completed["status"])
        self.assertEqual(hashlib.sha256(result).hexdigest(), completed["result_sha256"])

        repeated = self.ledger.complete("review-870", result)
        self.assertEqual(completed["result_sha256"], repeated["result_sha256"])
        events = self.ledger.list_events(task_id="review-870", event_type="completion")
        self.assertEqual(["completion:review-870"], [event["key"] for event in events])
        with self.assertRaisesRegex(ValueError, "immutable result"):
            self.ledger.complete("review-870", b"different result\n")

    def test_completion_reconciles_each_injected_crash_point(self):
        result = b"# Evidence\n\nchecks passed\n"
        for failpoint in ("after_result", "after_task", "after_event"):
            with self.subTest(failpoint=failpoint):
                task_id = f"task-{failpoint}"
                if failpoint != "after_result":
                    self.ledger.cancel_open_task("app-review")
                self.assign(task_id)
                with self.assertRaisesRegex(RuntimeError, failpoint):
                    self.ledger.complete(task_id, result, failpoint=failpoint)
                recovered = self.ledger.complete(task_id, result)
                self.assertEqual("complete", recovered["status"])
                events = self.ledger.list_events(task_id=task_id, event_type="completion")
                self.assertEqual(1, len(events))

    def test_idle_attention_is_level_triggered_until_task_disposition(self):
        self.assign()
        self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.ledger.mark_delivered("review-870", pane_nonce="nonce-22-a")
        self.ledger.accept("review-870", pane_nonce="nonce-22-a")
        event = self.ledger.observe_idle("app-review", pane_nonce="nonce-22-a")
        self.assertEqual("attention:review-870", event["key"])
        self.ledger.mark_notified([event["key"]], retry_after=60)
        self.assertEqual([], self.ledger.events_due(now=1_059))
        self.assertEqual([event["key"]], [item["key"] for item in self.ledger.events_due(now=1_060)])
        with self.assertRaisesRegex(ValueError, "task disposition"):
            self.ledger.ack([event["key"]])

        self.ledger.complete("review-870", b"# Result\n\nDone.\n")
        self.ledger.ack([event["key"]])
        self.assertEqual("acked", self.ledger.get_event(event["key"])["status"])

    def test_failed_component_collection_does_not_advance_baseline(self):
        first = self.ledger.record_component("github", snapshot=b"head-a\n", healthy=True)
        self.assertEqual(hashlib.sha256(b"head-a\n").hexdigest(), first["snapshot_sha256"])
        failed = self.ledger.record_component("github", healthy=False, error="timeout")
        self.assertEqual(first["snapshot_sha256"], failed["snapshot_sha256"])
        recovered = self.ledger.record_component("github", snapshot=b"head-b\n", healthy=True)
        self.assertNotEqual(first["snapshot_sha256"], recovered["snapshot_sha256"])

    def test_snapshot_changes_emit_one_bounded_diff_event(self):
        self.assertIsNone(self.ledger.record_snapshot("github", b"pr=870 pending\n"))
        self.assertIsNone(self.ledger.record_snapshot("github", b"pr=870 pending\n"))
        event = self.ledger.record_snapshot("github", b"pr=870 success\n")
        self.assertEqual("sensor", event["type"])
        self.assertTrue(event["key"].startswith("sensor:github:"))
        payload = Path(event["payload_path"]).read_text()
        self.assertIn("-pr=870 pending", payload)
        self.assertIn("+pr=870 success", payload)
        repeated = self.ledger.record_snapshot("github", b"pr=870 success\n")
        self.assertIsNone(repeated)
        self.assertEqual(1, len(self.ledger.list_events(event_type="sensor")))

        large = b"x" * (80 * 1024)
        truncated = self.ledger.record_snapshot("github", large)
        bounded = Path(truncated["payload_path"]).read_bytes()
        self.assertLessEqual(len(bounded), 64 * 1024)
        self.assertIn(b"[DIFF TRUNCATED]", bounded)

    def test_codex_and_claude_lanes_share_schema_but_keep_adapter_identity(self):
        self.ledger.register_lane(
            lane="infra-claude",
            pane_id="%8",
            nonce="nonce-8-a",
            harness="claude",
            repo="/repo/hill90",
            server_id="server-a",
            session_id="$4",
            command="claude.exe",
        )
        codex_lane = self.ledger.get_lane("app-review")
        claude_lane = self.ledger.get_lane("infra-claude")
        self.assertEqual(set(codex_lane), set(claude_lane))
        self.assertEqual("codex", codex_lane["harness"])
        self.assertEqual("claude", claude_lane["harness"])
        self.assertNotEqual(codex_lane["nonce"], claude_lane["nonce"])

    def test_concurrent_assignments_leave_exactly_one_open_task(self):
        def assign(task_id):
            ledger = Ledger(Path(self.tempdir.name), clock=self.clock)
            try:
                ledger.assign(
                    task_id=task_id,
                    lane="app-review",
                    pane_nonce="nonce-22-a",
                    summary=f"Task {task_id}",
                )
                return "created"
            except ValueError as error:
                return str(error)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(assign, ("race-a", "race-b")))
        self.assertEqual(1, outcomes.count("created"))
        self.assertEqual(1, sum("outstanding task" in outcome for outcome in outcomes))
        open_tasks = [task for task in self.ledger.list_tasks() if task["status"] not in ("complete", "failed", "cancelled")]
        self.assertEqual(1, len(open_tasks))


class TaskTableMigrationTest(unittest.TestCase):
    """Blocker 1: `CREATE TABLE IF NOT EXISTS` does not migrate an existing DB."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        _seed_pre_pr_database(self.root)

    def _raw_tasks_sql(self):
        connection = sqlite3.connect(self.root / "ledger.sqlite3")
        try:
            return connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
            ).fetchone()[0]
        finally:
            connection.close()

    def _raw_task_row(self, task_id="review-870"):
        connection = sqlite3.connect(self.root / "ledger.sqlite3")
        connection.row_factory = sqlite3.Row
        try:
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return dict(row) if row else None
        finally:
            connection.close()

    def test_reproduction_old_check_constraint_rejects_delivery_pending_directly(self):
        """Before any migration exists, writing delivery_pending to the raw
        pre-PR schema must fail - this is the bug the migration fixes."""
        connection = sqlite3.connect(self.root / "ledger.sqlite3")
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE tasks SET status = 'delivery_pending' WHERE id = 'review-870'")
        finally:
            connection.close()

    def test_opening_pre_pr_database_migrates_schema_and_preserves_every_row(self):
        before = self._raw_task_row()
        self.assertEqual("created", before["status"])
        self.assertNotIn("delivery_attempted_at", before)

        ledger = Ledger(self.root, clock=lambda: 2_000)

        migrated_sql = self._raw_tasks_sql()
        self.assertIn("delivery_pending", migrated_sql)
        self.assertIn("delivery_attempted_at", migrated_sql)

        after = ledger.get_task("review-870")
        self.assertEqual(before["id"], after["id"])
        self.assertEqual(before["lane"], after["lane"])
        self.assertEqual(before["pane_nonce"], after["pane_nonce"])
        self.assertEqual(before["summary"], after["summary"])
        self.assertEqual(before["status"], after["status"])
        self.assertEqual(before["created_at"], after["created_at"])
        self.assertIsNone(after["delivery_attempted_at"])

        # Every other table, and the lane row the task's FK depends on, survives untouched.
        self.assertEqual(1, len(ledger.list_lanes()))
        self.assertEqual(1, len(ledger.list_tasks()))
        self.assertEqual(1, len(ledger.list_events()))

        # The FK from events to tasks is intact and still enforced by name.
        connection = sqlite3.connect(self.root / "ledger.sqlite3")
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO events(key, type, task_id, status, created_at) "
                    "VALUES ('bad', 'attention', 'does-not-exist', 'pending', 2000)"
                )
                connection.commit()
        finally:
            connection.close()

        # The whole point: mark_delivery_pending now works against the migrated schema.
        pending = ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.assertEqual("delivery_pending", pending["status"])

        # The one_open_task_per_lane index survived: a second open task on the same lane still fails.
        with self.assertRaisesRegex(ValueError, "outstanding task"):
            ledger.assign(task_id="review-871", lane="app-review", pane_nonce="nonce-22-a", summary="Second task")

    def test_migration_failure_rolls_back_leaving_original_table_and_rows_intact(self):
        for failpoint in ("after_create", "after_copy", "after_drop", "after_rename"):
            with self.subTest(failpoint=failpoint):
                root = Path(tempfile.mkdtemp())
                self.addCleanup(lambda r=root: __import__("shutil").rmtree(r, ignore_errors=True))
                _seed_pre_pr_database(root)

                with self.assertRaisesRegex(RuntimeError, failpoint):
                    Ledger(root, clock=lambda: 2_000, _migration_failpoint=failpoint)

                # Rolled back: the table is exactly as it was before the attempt.
                connection = sqlite3.connect(root / "ledger.sqlite3")
                connection.row_factory = sqlite3.Row
                try:
                    sql = connection.execute(
                        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
                    ).fetchone()["sql"]
                    self.assertNotIn("delivery_pending", sql, f"schema leaked past rollback at {failpoint}")
                    row = dict(connection.execute("SELECT * FROM tasks WHERE id='review-870'").fetchone())
                    self.assertEqual("created", row["status"])
                    self.assertEqual(1, connection.execute("SELECT COUNT(*) FROM tasks").fetchone()[0])
                    self.assertEqual(1, connection.execute("SELECT COUNT(*) FROM events").fetchone()[0])
                finally:
                    connection.close()

                # And migration recovers cleanly on the very next open.
                recovered = Ledger(root, clock=lambda: 3_000)
                self.assertIn("delivery_pending", self._migrated_sql(root))
                after = recovered.get_task("review-870")
                self.assertEqual("created", after["status"])
                pending = recovered.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
                self.assertEqual("delivery_pending", pending["status"])

    @staticmethod
    def _migrated_sql(root):
        connection = sqlite3.connect(root / "ledger.sqlite3")
        try:
            return connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
            ).fetchone()[0]
        finally:
            connection.close()

    def test_fresh_ledger_never_triggers_a_migration_rebuild(self):
        """A brand-new state directory has the current schema from CREATE TABLE
        IF NOT EXISTS alone; `_migrate_tasks_table` must be a no-op for it."""
        fresh_root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(fresh_root, ignore_errors=True))
        ledger = Ledger(fresh_root, clock=lambda: 1_000)
        ledger.register_lane(
            lane="app-review", pane_id="%1", nonce="n", harness="codex", repo="/r",
            server_id="s", session_id="$1", command="codex",
        )
        task = ledger.assign(task_id="t1", lane="app-review", pane_nonce="n", summary="Do the thing")
        self.assertEqual("created", task["status"])
        pending = ledger.mark_delivery_pending("t1", pane_nonce="n")
        self.assertEqual("delivery_pending", pending["status"])


class DeliveryTimestampTest(unittest.TestCase):
    """Correctness defect: mark_delivery_pending must not write delivered_at."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.clock = MutableClock()
        self.ledger = Ledger(Path(self.tempdir.name), clock=self.clock)
        self.ledger.register_lane(
            lane="app-review", pane_id="%22", nonce="nonce-22-a", harness="codex", repo="/repo/app",
            server_id="server-a", session_id="$4", command="codex",
        )
        self.ledger.assign(
            task_id="review-870", lane="app-review", pane_nonce="nonce-22-a",
            summary="Review PR 870 without editing",
        )

    def test_mark_delivery_pending_sets_delivery_attempted_at_not_delivered_at(self):
        self.clock.value = 1_500
        pending = self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.assertEqual(1_500, pending["delivery_attempted_at"])
        self.assertIsNone(pending["delivered_at"])

    def test_confirmed_delivery_sets_delivered_at_and_keeps_attempt_timestamp(self):
        self.clock.value = 1_500
        self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.clock.value = 1_600
        delivered = self.ledger.mark_delivered("review-870", pane_nonce="nonce-22-a")
        self.assertEqual(1_500, delivered["delivery_attempted_at"])
        self.assertEqual(1_600, delivered["delivered_at"])

    def test_failed_reconciliation_leaves_delivered_at_null_but_retains_attempt_timestamp(self):
        self.clock.value = 1_500
        self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-22-a")
        self.clock.value = 1_700
        retired = self.ledger.reconcile_delivery("review-870", pane_nonce="nonce-22-a", outcome="failed")
        self.assertEqual("failed", retired["status"])
        self.assertIsNone(retired["delivered_at"])
        self.assertEqual(1_500, retired["delivery_attempted_at"])
        self.assertEqual(1_700, retired["completed_at"])


class ReconcileAfterReRegistrationTest(unittest.TestCase):
    """Blocker 2: reconcile must survive a re-registered lane."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.clock = MutableClock()
        self.ledger = Ledger(Path(self.tempdir.name), clock=self.clock)
        self.ledger.register_lane(
            lane="app-review", pane_id="%22", nonce="nonce-dead", harness="codex", repo="/repo/app",
            server_id="server-a", session_id="$4", command="codex",
        )
        self.ledger.assign(
            task_id="review-870", lane="app-review", pane_nonce="nonce-dead",
            summary="Review PR 870 without editing",
        )
        self.ledger.mark_delivery_pending("review-870", pane_nonce="nonce-dead")

    def test_reproduction_reconciling_with_the_lanes_current_nonce_wedges(self):
        """Reproduces the reported bug: passing the LANE's current (new)
        nonce - the CLI's old behavior - fails against the task's own
        pane_nonce recorded at send time."""
        self.ledger.register_lane(
            lane="app-review", pane_id="%23", nonce="nonce-reborn", harness="codex", repo="/repo/app",
            server_id="server-a", session_id="$4", command="codex",
        )
        current_lane_nonce = self.ledger.get_lane("app-review")["nonce"]
        self.assertEqual("nonce-reborn", current_lane_nonce)
        with self.assertRaisesRegex(ValueError, "pane incarnation does not match task"):
            self.ledger.reconcile_delivery("review-870", pane_nonce=current_lane_nonce, outcome="delivered")

    def test_reconcile_with_task_pane_nonce_succeeds_after_lane_re_registration(self):
        self.ledger.register_lane(
            lane="app-review", pane_id="%23", nonce="nonce-reborn", harness="codex", repo="/repo/app",
            server_id="server-a", session_id="$4", command="codex",
        )
        task_pane_nonce = self.ledger.get_task("review-870")["pane_nonce"]
        self.assertEqual("nonce-dead", task_pane_nonce)
        reconciled = self.ledger.reconcile_delivery("review-870", pane_nonce=task_pane_nonce, outcome="delivered")
        self.assertEqual("delivered", reconciled["status"])

    def test_reconcile_still_rejects_a_wrong_task_nonce(self):
        with self.assertRaisesRegex(ValueError, "pane incarnation does not match task"):
            self.ledger.reconcile_delivery("review-870", pane_nonce="some-guessed-nonce", outcome="delivered")


if __name__ == "__main__":
    unittest.main()
