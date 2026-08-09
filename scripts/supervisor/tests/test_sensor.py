import json
import sys
import tempfile
import unittest
from pathlib import Path


SUPERVISOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPERVISOR_DIR))

from core import Ledger  # noqa: E402
from sensor import StateSensor  # noqa: E402


class FakeRunner:
    def __init__(self):
        self.head = "head-a"
        self.pr_state = "PENDING"
        self.fail_github = False

    def __call__(self, command):
        if command[0] == "git":
            if "rev-parse" in command:
                return self.head + "\n"
            return ""
        if self.fail_github:
            raise RuntimeError("github unavailable")
        if command[1:3] == ["pr", "list"]:
            return json.dumps([{"number": 870, "headRefOid": self.head, "updatedAt": "now", "checks": [self.pr_state]}])
        if command[1:3] == ["issue", "list"]:
            return json.dumps([{"number": 776, "updatedAt": "now"}])
        raise AssertionError(command)


class SensorTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.ledger = Ledger(Path(self.tempdir.name), clock=lambda: 1_000)
        self.runner = FakeRunner()
        self.sensor = StateSensor(
            self.ledger,
            self.runner,
            [{"name": "Hill90", "path": "/repo/Hill90", "github": "jonhill90/Hill90"}],
        )

    def test_first_collection_is_baseline_and_changed_pr_emits_bounded_event(self):
        first = self.sensor.collect_all()
        self.assertEqual([], first["events"])
        self.runner.pr_state = "SUCCESS"
        changed = self.sensor.collect_all()
        self.assertEqual(1, len(changed["events"]))
        self.assertTrue(changed["events"][0].startswith("sensor:github-Hill90:"))
        unchanged = self.sensor.collect_all()
        self.assertEqual([], unchanged["events"])

    def test_github_failure_does_not_advance_its_baseline(self):
        self.sensor.collect_all()
        baseline = self.ledger.record_component("github-Hill90", snapshot=b"ignored", healthy=True)
        self.runner.fail_github = True
        failed = self.sensor.collect_all()
        self.assertEqual([{"component": "github-Hill90", "error": "github unavailable"}], failed["errors"])
        component = self.ledger.record_component("github-Hill90", healthy=False, error="still unavailable")
        self.assertEqual(baseline["snapshot_sha256"], component["snapshot_sha256"])


if __name__ == "__main__":
    unittest.main()
