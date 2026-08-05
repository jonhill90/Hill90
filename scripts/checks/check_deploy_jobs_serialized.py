#!/usr/bin/env python3
"""No two deploy jobs may be able to run at the same time.

THE DEFECT, twice in one hour on 2026-08-05.

Every deploy job SSHes to the same VPS and operates on the same checkout,
`/opt/hill90/app`, against the same running estate. `deploy.yml` already had a
`deploy-db -> deploy-auth -> deploy-minio` chain; `deploy-vault` and
`deploy-observability` hung off `changes` directly and so ran alongside it.

  * Run 31039334078 — `deploy-db` and `deploy-observability` both started at
    19:25:45Z. They raced on the git checkout and db died with
    `error: fetching ref refs/remotes/origin/main failed: incorrect old value
    provided`. `deploy-auth` was then skipped, so of three changed compose
    files only observability.yml reached production: a PARTIAL deploy,
    reported as one failed job. (#778)

  * Run 31040415190 — `deploy-auth` restarted Keycloak while the concurrent
    `deploy-observability` job's `grafana-role-login-test.sh` was mid-assertion
    against it. It failed with `no Keycloak login form in the response`, naming
    the wrong service entirely; Grafana was healthy throughout.

The two share a cause and NOT a resource: the first is contention on the git
checkout, the second on the running estate. That matters, because it rules out
"give each job its own checkout directory" — that fixes the first and leaves
the second untouched. Serialising fixes both.

WHAT THIS ASSERTS. For every pair of deploy jobs, one must be reachable from
the other through `needs`. That is exactly the condition "no two can be in
flight together", and it is stronger than eyeballing a chain: it also rejects
a fork, where two jobs each depend on a common ancestor but not on each other.

WHAT IT DOES NOT ASSERT. Not the order, and not that the order is a good one.
`deploy-observability` is deliberately last because its post-deploy checks
assert against the other services, but a reshuffle that keeps the chain intact
passes here — deliberately, so this check does not have to be edited every time
the estate's dependency story changes.

Hermetic: parses the workflow file. No network, no host. Runs in ci.yml.

Exit 0 PASS, 1 FAIL, 2 CANNOT DETERMINE.
"""
import sys
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy.yml"


def ancestors(job: str, needs: dict) -> set:
    """Every job that must complete before `job` can start."""
    seen, stack = set(), list(needs.get(job, []))
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(needs.get(cur, []))
    return seen


def main() -> int:
    if not WORKFLOW.exists():
        print(f"CANNOT DETERMINE — {WORKFLOW} does not exist")
        return 2

    doc = yaml.safe_load(WORKFLOW.read_text())
    jobs = doc.get("jobs") or {}

    needs = {}
    for name, body in jobs.items():
        n = (body or {}).get("needs") or []
        needs[name] = [n] if isinstance(n, str) else list(n)

    deploy_jobs = sorted(n for n in jobs if n.startswith("deploy-"))

    # The 0-inputs-scanned trap: with fewer than two deploy jobs there is no
    # pair to check, and "no violations found" would be a vacuous pass over an
    # empty set. Say so instead.
    if len(deploy_jobs) < 2:
        print(
            f"CANNOT DETERMINE — found {len(deploy_jobs)} job(s) named deploy-*, "
            "so there is no pair of concurrent deploys to rule out. Either the "
            "naming convention changed and this check is looking at nothing, or "
            "the workflow did. Fix this before trusting a green run."
        )
        return 2

    concurrent = []
    for i, a in enumerate(deploy_jobs):
        for b in deploy_jobs[i + 1 :]:
            if b not in ancestors(a, needs) and a not in ancestors(b, needs):
                concurrent.append((a, b))

    if concurrent:
        print("FAIL — these deploy jobs can run at the same time:")
        print()
        for a, b in concurrent:
            print(f"      {a}  ||  {b}")
        print()
        print("  Every deploy job SSHes to the same VPS, works in the same")
        print("  checkout (/opt/hill90/app) and deploys onto the same running")
        print("  estate. Two at once race on the git checkout (#778) and on the")
        print("  containers each other's post-deploy checks assert against.")
        print()
        print("  Chain them with `needs:` so the deploy jobs form a single path.")
        print("  Current graph:")
        for n in deploy_jobs:
            print(f"      {n:24} needs={needs[n]}")
        return 1

    print(f"PASS — the {len(deploy_jobs)} deploy jobs form a single chain; no two")
    print("       can be in flight against the VPS at once.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
