"""Selected Git and GitHub state sensor.

It records HEAD/worktree state plus open PR/check and issue timestamps. Local
branch inventories and terminal scrollback are intentionally excluded.
"""

from __future__ import annotations

import json
import subprocess


def subprocess_runner(command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


class StateSensor:
    def __init__(self, ledger, runner=None, repositories=()):
        self.ledger = ledger
        self.runner = runner or subprocess_runner
        self.repositories = repositories

    def _collect_git(self, repository):
        repo_path = repository["path"]
        head = self.runner(["git", "-C", repo_path, "rev-parse", "HEAD"]).strip()
        upstream = self.runner(["git", "-C", repo_path, "rev-parse", "origin/main"]).strip()
        status = self.runner(["git", "-C", repo_path, "status", "--porcelain=v1"]).splitlines()
        return json.dumps(
            {"head": head, "origin_main": upstream, "status": status},
            sort_keys=True,
            separators=(",", ":"),
        ).encode() + b"\n"

    def _collect_github(self, repository):
        github = repository["github"]
        prs = self.runner(
            [
                "gh", "pr", "list", "--repo", github, "--state", "open", "--limit", "100",
                "--json", "number,headRefOid,updatedAt,statusCheckRollup",
                "--jq", "[.[] | {number,headRefOid,updatedAt,checks:[.statusCheckRollup[]? | (.conclusion // .state // .status)]}] | sort_by(.number)",
            ]
        )
        issues = self.runner(
            [
                "gh", "issue", "list", "--repo", github, "--state", "open", "--limit", "100",
                "--json", "number,updatedAt", "--jq", "sort_by(.number)",
            ]
        )
        normalized = {
            "issues": json.loads(issues),
            "prs": json.loads(prs),
        }
        return json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode() + b"\n"

    def collect_all(self):
        events = []
        errors = []
        for repository in self.repositories:
            for source, collector in (("git", self._collect_git), ("github", self._collect_github)):
                component = f"{source}-{repository['name']}"
                try:
                    snapshot = collector(repository)
                    event = self.ledger.record_snapshot(component, snapshot)
                    if event is not None:
                        events.append(event["key"])
                except Exception as error:
                    self.ledger.record_component(component, healthy=False, error=str(error))
                    errors.append({"component": component, "error": str(error)})
        return {"events": events, "errors": errors}
