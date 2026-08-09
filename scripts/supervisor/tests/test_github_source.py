import json
import sys
import unittest
import tempfile
import contextlib
import io
from pathlib import Path
from unittest.mock import patch


SUPERVISOR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPERVISOR_DIR))

from github_source import GithubTaskSource, marker  # noqa: E402
from core import Ledger  # noqa: E402
import cli  # noqa: E402


SHA = "a" * 40
ISSUE_URL = "https://github.com/jonhill90/Hill90/issues/42"
PULL_URL = "https://github.com/jonhill90/Hill90/pull/43"


class FakeGh:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def __call__(self, command):
        self.calls.append(command)
        if command[:3] == ["gh", "api", f"repos/jonhill90/Hill90/commits/{SHA}"]:
            return SHA + "\n"
        if command[:3] in (["gh", "issue", "view"], ["gh", "pr", "view"]):
            return json.dumps(self.payload)
        if command[:3] in (["gh", "issue", "comment"], ["gh", "pr", "comment"]):
            return ""
        raise AssertionError(command)


def task_marker(url, task_id, source_ref=SHA):
    return marker(
        {
            "kind": "task",
            "source_ref": source_ref,
            "source_url": url,
            "task_id": task_id,
        }
    )


class RecordingSpool:
    def __init__(self):
        self.records = []

    def reconstruct_task(self, **record):
        self.records.append(record)
        return record


class RecordingGithubSource:
    instances = []

    def __init__(self):
        self.calls = []
        self.__class__.instances.append(self)

    def reconstruct(self, ledger, *, source_url, source_ref):
        self.calls.append((ledger, source_url, source_ref))
        return {"task_id": "gh.jonhill90.Hill90.issue.42", "source_url": source_url, "source_ref": source_ref}


class GithubTaskSourceTest(unittest.TestCase):
    def test_load_issue_derives_immutable_identity_and_latest_marked_status(self):
        task_id = "gh.jonhill90.Hill90.issue.42"
        payload = {
            "number": 42,
            "url": ISSUE_URL,
            "title": "Review the deploy guard",
            "state": "CLOSED",
            "body": task_marker(ISSUE_URL, task_id),
            "comments": [
                {
                    "createdAt": "2026-08-09T10:00:00Z",
                    "body": marker(
                        {
                            "evidence": ["https://github.com/jonhill90/Hill90/actions/runs/9"],
                            "kind": "status",
                            "source_ref": SHA,
                            "source_url": ISSUE_URL,
                            "status": "complete",
                            "task_id": task_id,
                        }
                    ),
                }
            ],
        }
        gh = FakeGh(payload)

        record = GithubTaskSource(gh).load(source_url=ISSUE_URL, source_ref=SHA)

        self.assertEqual(task_id, record["task_id"])
        self.assertEqual(ISSUE_URL, record["source_url"])
        self.assertEqual(SHA, record["source_ref"])
        self.assertEqual("issue", record["source_kind"])
        self.assertEqual("complete", record["status"])
        self.assertEqual(payload["comments"][0]["body"], record["status_marker"])
        self.assertEqual(
            ["https://github.com/jonhill90/Hill90/actions/runs/9"], record["evidence"]
        )
        self.assertEqual(
            [
                ["gh", "issue", "view", "42", "--repo", "jonhill90/Hill90", "--json", "number,url,title,body,state,comments"],
                ["gh", "api", f"repos/jonhill90/Hill90/commits/{SHA}", "--jq", ".sha"],
            ],
            gh.calls,
        )

    def test_load_pr_requires_its_head_to_match_the_required_immutable_ref(self):
        task_id = "gh.jonhill90.Hill90.pull.43"
        payload = {
            "number": 43,
            "url": PULL_URL,
            "title": "Do not drift",
            "state": "OPEN",
            "headRefOid": "b" * 40,
            "body": task_marker(PULL_URL, task_id),
            "comments": [],
        }

        with self.assertRaisesRegex(ValueError, "head ref does not match"):
            GithubTaskSource(FakeGh(payload)).load(source_url=PULL_URL, source_ref=SHA)

    def test_markers_bind_the_returned_source_url_and_require_terminal_evidence(self):
        task_id = "gh.jonhill90.Hill90.issue.42"
        payload = {
            "number": 42,
            "url": ISSUE_URL,
            "title": "Review the deploy guard",
            "state": "CLOSED",
            "body": task_marker(ISSUE_URL, task_id),
            "comments": [
                {
                    "createdAt": "2026-08-09T10:00:00Z",
                    "body": marker(
                        {
                            "evidence": [],
                            "kind": "status",
                            "source_ref": SHA,
                            "source_url": ISSUE_URL,
                            "status": "complete",
                            "task_id": task_id,
                        }
                    ),
                }
            ],
        }

        with self.assertRaisesRegex(ValueError, "terminal status requires evidence"):
            GithubTaskSource(FakeGh(payload)).load(source_url=ISSUE_URL, source_ref=SHA)

        payload["body"] = task_marker("https://github.com/jonhill90/Hill90/issues/999", task_id)
        with self.assertRaisesRegex(ValueError, "task marker source URL"):
            GithubTaskSource(FakeGh(payload)).load(source_url=ISSUE_URL, source_ref=SHA)

    def test_reconstruct_populates_an_empty_delivery_spool_from_github_only(self):
        task_id = "gh.jonhill90.Hill90.issue.42"
        payload = {
            "number": 42,
            "url": ISSUE_URL,
            "title": "Review the deploy guard",
            "state": "OPEN",
            "body": task_marker(ISSUE_URL, task_id),
            "comments": [],
        }
        spool = RecordingSpool()

        reconstructed = GithubTaskSource(FakeGh(payload)).reconstruct(
            spool, source_url=ISSUE_URL, source_ref=SHA
        )

        self.assertEqual(1, len(spool.records))
        self.assertEqual(reconstructed, spool.records[0])
        self.assertEqual("created", reconstructed["status"])
        self.assertEqual([], reconstructed["evidence"])

    def test_reconstruct_populates_a_real_empty_ledger_without_a_tmux_lane(self):
        task_id = "gh.jonhill90.Hill90.issue.42"
        payload = {
            "number": 42,
            "url": ISSUE_URL,
            "title": "Review the deploy guard",
            "state": "OPEN",
            "body": task_marker(ISSUE_URL, task_id),
            "comments": [],
        }
        with tempfile.TemporaryDirectory() as state_dir:
            ledger = Ledger(Path(state_dir), clock=lambda: 1_000)
            reconstructed = GithubTaskSource(FakeGh(payload)).reconstruct(
                ledger, source_url=ISSUE_URL, source_ref=SHA
            )

            self.assertEqual(reconstructed, ledger.get_source_task(task_id))
            self.assertEqual([reconstructed], ledger.list_source_tasks())
            self.assertEqual([], ledger.list_tasks())

    def test_publish_status_writes_a_deterministic_github_receipt(self):
        task_id = "gh.jonhill90.Hill90.issue.42"
        payload = {
            "number": 42,
            "url": ISSUE_URL,
            "title": "Review the deploy guard",
            "state": "OPEN",
            "body": task_marker(ISSUE_URL, task_id),
            "comments": [],
        }
        gh = FakeGh(payload)

        receipt = GithubTaskSource(gh).publish_status(
            source_url=ISSUE_URL, source_ref=SHA, status="accepted", evidence=[]
        )

        self.assertEqual(
            marker(
                {
                    "evidence": [],
                    "kind": "status",
                    "source_ref": SHA,
                    "source_url": ISSUE_URL,
                    "status": "accepted",
                    "task_id": task_id,
                }
            ),
            receipt,
        )
        self.assertEqual(
            ["gh", "issue", "comment", "42", "--repo", "jonhill90/Hill90", "--body", receipt],
            gh.calls[-1],
        )

    def test_publish_refuses_terminal_status_without_evidence_before_writing(self):
        source = GithubTaskSource(lambda command: self.fail(f"unexpected gh call: {command}"))

        with self.assertRaisesRegex(ValueError, "terminal status requires evidence"):
            source.publish_status(source_url=ISSUE_URL, source_ref=SHA, status="complete", evidence=[])

    def test_cli_reconstruct_requires_source_url_and_immutable_ref(self):
        with tempfile.TemporaryDirectory() as state_dir:
            RecordingGithubSource.instances.clear()
            output = io.StringIO()
            with patch.object(cli, "GithubTaskSource", RecordingGithubSource), contextlib.redirect_stdout(output):
                self.assertEqual(
                    0,
                    cli.main(
                        [
                            "--state-dir",
                            state_dir,
                            "reconstruct",
                            "--source-url",
                            ISSUE_URL,
                            "--source-ref",
                            SHA,
                        ]
                    ),
                )
            self.assertEqual(
                {"source_ref": SHA, "source_url": ISSUE_URL, "task_id": "gh.jonhill90.Hill90.issue.42"},
                json.loads(output.getvalue()),
            )
            self.assertEqual(1, len(RecordingGithubSource.instances))
            _ledger, source_url, source_ref = RecordingGithubSource.instances[0].calls[0]
            self.assertEqual((ISSUE_URL, SHA), (source_url, source_ref))

    def test_missing_or_moving_ref_is_rejected_before_github_can_be_trusted(self):
        source = GithubTaskSource(lambda command: self.fail(f"unexpected gh call: {command}"))
        with self.assertRaisesRegex(ValueError, "immutable commit SHA"):
            source.load(source_url=ISSUE_URL, source_ref="main")
        with self.assertRaisesRegex(ValueError, "GitHub Issue or PR URL"):
            source.load(source_url="https://example.test/not-github", source_ref=SHA)


if __name__ == "__main__":
    unittest.main()
