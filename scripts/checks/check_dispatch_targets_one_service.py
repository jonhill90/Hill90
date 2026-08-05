#!/usr/bin/env python3
"""A manual deploy must deploy the service that was asked for, and no other.

THE DEFECT (run 31040415190, 2026-08-05). `deploy.yml` decides what to deploy
from two independent sources OR'd together: dorny/paths-filter output, and the
`service` workflow_dispatch input. On a dispatch the first source is not merely
unhelpful, it is actively wrong — the event payload has no `before` field, so
paths-filter falls back to "changes in the last commit", and actions/checkout's
default `fetch-depth: 1` leaves that commit with no parent. `git log
--name-status -n 1` against a parentless commit reports the whole repository as
added: "Detected 272 changed files", all five filters true.

The visible consequence was not a red job. `-f service=auth` deployed all five
services, and the Keycloak restart it caused landed underneath the concurrently
running observability job's Grafana login check, which failed on a login form
Keycloak was momentarily not serving. An operator asking for one service got the
estate, and the report blamed the wrong service.

WHAT THIS ASSERTS, and deliberately not more: that the change-detection step is
gated so it cannot run on a workflow_dispatch. It does not simulate a dispatch —
that needs GitHub — so the runtime proof is a real dispatch of one service with
only that service's job running — recorded on the PR that added this check.

Hermetic: reads the workflow file, no network, no host. Runs in ci.yml.

Exit 0 PASS, 1 FAIL, 2 CANNOT DETERMINE — the last so that a rename of the step
reports blindness rather than a clean run over nothing found.
"""
import re
import sys
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy.yml"


def main() -> int:
    if not WORKFLOW.exists():
        print(f"CANNOT DETERMINE — {WORKFLOW} does not exist")
        return 2

    text = WORKFLOW.read_text()

    # Find the paths-filter step and take the block up to the next step marker.
    start = text.find("- uses: dorny/paths-filter")
    if start == -1:
        print(
            "CANNOT DETERMINE — no dorny/paths-filter step in deploy.yml. Either "
            "change detection was replaced (in which case re-point this check at "
            "whatever replaced it) or it was removed. Not asserting a pass over a "
            "step that is not there."
        )
        return 2

    rest = text[start + 1 :]
    end = rest.find("\n      - ")
    block = rest[: end if end != -1 else len(rest)]

    if "workflow_dispatch" not in block or not re.search(r"\n\s+if:", block):
        print("FAIL — the change-detection step is not gated against workflow_dispatch.")
        print()
        print("  On a dispatch it reports every file in the repository as changed,")
        print("  so every per-service filter is true and every service deploys —")
        print("  whatever the `service` input said. The step needs:")
        print()
        print("      if: github.event_name != 'workflow_dispatch'")
        print()
        print("  Deepening the checkout does not fix it: the fallback is triggered")
        print("  by the missing `before` field in the payload, not by clone depth.")
        print()
        print("  The step as it stands:")
        for line in block.strip().splitlines()[:6]:
            print(f"      {line}")
        return 1

    # A gate that permits dispatch through is worse than none, because it reads
    # as fixed. Require the sense of the comparison, not just the two words.
    if not re.search(r"if:\s*github\.event_name\s*!=\s*'workflow_dispatch'", block):
        print("FAIL — the step has a workflow_dispatch gate, but not one that excludes it.")
        print()
        print("  Expected `if: github.event_name != 'workflow_dispatch'`. Found:")
        for line in block.strip().splitlines()[:6]:
            print(f"      {line}")
        return 1

    print("PASS — change detection is gated to non-dispatch events, so a manual")
    print("       deploy is decided by the `service` input alone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
