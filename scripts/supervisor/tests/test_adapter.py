import sys
import tempfile
import unittest
from pathlib import Path


SUPERVISOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPERVISOR_DIR))

from adapter import TmuxAdapter, classify_capture  # noqa: E402
from core import Ledger  # noqa: E402


class FakeTransport:
    def __init__(self):
        self.panes = {
            "%19": {
                "pane_id": "%19",
                "command": "codex",
                "path": "/repo/hill90",
                "server_id": "server-a",
                "session_id": "$4",
                "capture": "─ Worked for 1m ─\n\n› Continue\n",
                "options": {},
                "after_send": "• Working (1s • esc to interrupt)\n\n› Continue\n",
            },
            "%8": {
                "pane_id": "%8",
                "command": "claude.exe",
                "path": "/repo/hill90",
                "server_id": "server-a",
                "session_id": "$4",
                "capture": "✻ Crunched for 1s\n\n❯ \n────────────────\n",
                "options": {},
                "after_send": "✻ Thinking…\n\n❯ \n────────────────\n",
            },
        }
        self.sends = []

    def metadata(self, target):
        return dict(self.panes[target])

    def capture(self, target, lines=25):
        return self.panes[target]["capture"]

    def set_option(self, target, name, value):
        self.panes[target]["options"][name] = value

    def get_option(self, target, name):
        return self.panes[target]["options"].get(name, "")

    def send_literal(self, target, payload):
        self.sends.append((target, payload))
        self.panes[target]["capture"] = payload + "\n" + self.panes[target]["after_send"]


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.ledger = Ledger(Path(self.tempdir.name), clock=lambda: 1_000)
        self.transport = FakeTransport()
        self.adapter = TmuxAdapter(self.ledger, self.transport, clock=lambda: 1_000)
        self.adapter.register_lane(
            lane="architecture", target="%19", harness="codex", repo="/repo/hill90", nonce="nonce-19"
        )
        self.adapter.register_lane(
            lane="infra-claude", target="%8", harness="claude", repo="/repo/hill90", nonce="nonce-8"
        )

    def test_harness_classifiers_cover_idle_active_blocked_and_approval(self):
        self.assertEqual("idle", classify_capture("codex", "─ Worked for 1m ─\n\n› Continue\n"))
        self.assertEqual("active", classify_capture("codex", "• Working (2s • esc to interrupt)\n› Continue\n"))
        self.assertEqual("blocked", classify_capture("codex", "■ You've hit your usage limit.\n› Continue\n"))
        self.assertEqual("idle", classify_capture("claude", "✻ Crunched for 1s\n\n❯ \n────────\n"))
        self.assertEqual("active", classify_capture("claude", "✻ Thinking…\n\n❯ \n────────\n"))
        self.assertEqual("blocked", classify_capture("claude", "You've hit your weekly limit · resets tomorrow\n❯ \n"))
        self.assertEqual("approval", classify_capture("claude", "Allow this command? [Y/n]\n❯ \n"))

    def test_assignment_is_task_bound_and_accepts_real_codex_and_claude_activity(self):
        codex = self.adapter.assign_task(
            lane="architecture", task_id="codex-task", summary="Review one artifact"
        )
        claude = self.adapter.assign_task(
            lane="infra-claude", task_id="claude-task", summary="Inspect one issue"
        )
        self.assertEqual("delivered", codex["status"])
        self.assertEqual("delivered", claude["status"])
        self.assertIn("codex-task", self.transport.sends[0][1])
        self.assertIn("claude-task", self.transport.sends[1][1])
        self.assertIn("complete", self.transport.sends[0][1])

    def test_blocked_lane_gets_no_assignment_input(self):
        self.transport.panes["%8"]["capture"] = "You've hit your weekly limit\n❯ \n"
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            self.adapter.assign_task(lane="infra-claude", task_id="blocked-task", summary="Do not send")
        self.assertEqual([], self.transport.sends)
        self.assertIsNone(self.ledger.get_task("blocked-task"))

    def test_idle_outstanding_task_emits_attention_without_observed_transition(self):
        self.adapter.assign_task(lane="architecture", task_id="short-task", summary="Short review")
        self.transport.panes["%19"]["capture"] = "Review finished\n─ Worked for 2m ─\n\n› Continue\n"
        event = self.adapter.observe_lane("architecture")
        self.assertEqual("attention:short-task", event["key"])
        repeated = self.adapter.observe_lane("architecture")
        self.assertEqual(event["key"], repeated["key"])

    def test_blocked_after_echo_does_not_ack_architecture_notification(self):
        self.adapter.assign_task(lane="infra-claude", task_id="review-task", summary="Review")
        self.ledger.complete("review-task", b"# Result\n\nNo findings.\n")
        self.transport.panes["%19"]["after_send"] = "■ You have hit your usage limit.\n\n› Continue\n"
        notified = self.adapter.notify_architecture(lane="architecture", retry_after=900)
        self.assertFalse(notified)
        event = self.ledger.get_event("completion:review-task")
        self.assertEqual("pending", event["status"])

    def test_reused_pane_id_with_wrong_nonce_is_rejected_before_send(self):
        self.transport.panes["%19"]["options"]["@hill90_lane_nonce"] = "reused"
        with self.assertRaisesRegex(RuntimeError, "incarnation"):
            self.adapter.assign_task(lane="architecture", task_id="wrong-pane", summary="Must not send")
        self.assertEqual([], self.transport.sends)

    def test_one_hundred_unchanged_observations_send_nothing(self):
        for _ in range(100):
            self.assertIsNone(self.adapter.observe_lane("architecture"))
            self.assertFalse(self.adapter.notify_architecture(lane="architecture", retry_after=900))
        self.assertEqual([], self.transport.sends)


if __name__ == "__main__":
    unittest.main()
