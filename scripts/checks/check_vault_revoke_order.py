#!/usr/bin/env python3
"""No path may reach a root-token revoke with the OIDC auth method not yet enabled.

WHY
===

Revoking root is EXPENSIVE to undo on OpenBao >= 2.5.3: the unauthenticated
root-generation endpoints are disabled by default, so whatever was not configured
before the revoke cannot be configured after it without redeploying the vault on
platform/vault/config.recovery.hcl and minting root from the unseal key
(scripts/vault.sh regain-root, proven 2026-08-02). This docstring called it a
ONE-WAY DOOR and that was wrong — `bao operator generate-root`'s 403 comes from a
legacy path, not from an irreversible state. The guard stays: recovery means a
production config change, two restarts, and a window where an unseal key share
alone mints root. That produced a healthy, unconfigurable vault on
2026-07-26 — and again on 2026-08-02, this time by FOLLOWING the documented
recovery, because the reinitialise workflow never enabled OIDC and
`bootstrap-approles` revokes root when it finishes.

WHAT IS ACTUALLY ASSERTED
=========================

Not "does a workflow mention setup-oidc somewhere". The question is whether any
PATH can reach a revoke with OIDC not yet enabled, so this reasons about order:

1. For each workflow, extract the `scripts/vault.sh <verb>` invocations IN STEP
   ORDER, carrying each step's `if:` condition. If `revoke-root` can be reached
   without `setup-oidc` strictly earlier in the same job, that is a failure.
   A step guarded by an `if:` still counts as reachable — a condition an operator
   controls is not a guarantee.

2. `scripts/vault.sh` must guard the revoke itself. Workflow ordering cannot cover
   `vault.sh revoke-root` run by hand, nor `bootstrap-approles`'s own terminal
   revoke, so both revoke sites must call `assert_safe_to_revoke`.

Exit 0 if no path can close the door. Exit 1, naming the path, otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
VAULT_SH = ROOT / "scripts/vault.sh"

# Only EXECUTED invocations count. `bash scripts/vault.sh <verb>` is a run; a verb
# inside an `echo` is documentation telling the operator what to do next, and
# counting it produced two false positives on the first draft — a check that cries
# wolf gets ignored, which is the failure mode this whole file exists to prevent.
VERB = re.compile(r"bash\s+scripts/vault\.sh\s+([a-z][a-z0-9-]*)")

# Verbs that REVOKE the root token. `revoke-root` is the obvious one;
# `bootstrap-approles` revokes on its way out — read it in scripts/vault.sh:
# cmd_bootstrap_approles ends with `assert_safe_to_revoke` then
# `token revoke -self`. It was omitted here, so a workflow that ran
# bootstrap-approles before setup-oidc passed this check while being exactly the
# sequence that closed the door in #643. Nothing invokes it from a workflow today;
# that is the reason to encode it now rather than after something does.
REVOKING_VERBS = ("revoke-root", "bootstrap-approles")
ECHOED = re.compile(r"^\s*echo\b")
STEP = re.compile(r"^\s*-\s+name:\s*(.+?)\s*$")
# Job boundaries. GitHub jobs are INDEPENDENT unless chained with `needs:`, so
# `setup-oidc` in one job does not protect a revoke in another.
JOBS_KEY = re.compile(r"^jobs:\s*$")
JOB_NAME = re.compile(r"^  ([A-Za-z0-9_.\-]+):\s*$")


def split_jobs(text: str):
    """[(job_name, job_text)] — or one ("<file>", text) segment if `jobs:` is absent.

    WHY THIS EXISTS. The check used to carry `seen_oidc` across the WHOLE FILE, so
    a workflow with `setup-oidc` in job A and `revoke-root` in job B passed —
    verified 2026-08-03 with a two-job fixture that the check happily accepted.
    Job B can run with OIDC never having been enabled, which is precisely the path
    this file exists to forbid, and the docstring already claimed it reasoned
    about paths. It did not."""
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if JOBS_KEY.match(l)), None)
    if start is None:
        return [("<file>", text)]
    jobs, name, buf = [], None, []
    for line in lines[start + 1:]:
        m = JOB_NAME.match(line)
        if m:
            if name is not None:
                jobs.append((name, "\n".join(buf)))
            name, buf = m.group(1), []
        else:
            buf.append(line)
    if name is not None:
        jobs.append((name, "\n".join(buf)))
    return jobs or [("<file>", text)]


def steps_with_verbs(text: str):
    """Ordered (step-name, [verbs]) pairs. Deliberately line-based rather than a
    YAML walk: the invocations live inside `run: |` blocks and inside single-quoted
    ssh payloads, and step ORDER is exactly what matters."""
    out, name, buf = [], None, []
    for line in text.splitlines():
        m = STEP.match(line)
        if m:
            if name is not None:
                out.append((name, VERB.findall("\n".join(buf))))
            name, buf = m.group(1), []
        elif not ECHOED.match(line):
            buf.append(line)
    if name is not None:
        out.append((name, VERB.findall("\n".join(buf))))
    return out


def check_workflow(path: Path) -> list[str]:
    problems = []
    for job, job_text in split_jobs(path.read_text(encoding="utf-8")):
        # Reset per JOB, not per file: jobs run independently.
        seen_oidc = False
        for name, verbs in steps_with_verbs(job_text):
            for v in verbs:
                if v == "setup-oidc":
                    seen_oidc = True
                elif v in REVOKING_VERBS and not seen_oidc:
                    problems.append(
                        f"{path.name}: job {job!r}, step {name!r} can reach "
                        f"`vault.sh {v}` — which revokes root — with the OIDC auth "
                        f"method not yet enabled; no `setup-oidc` runs before it in "
                        f"THIS job. Undoing that needs a full root-recovery run "
                        f"(vault-regain-root.yml)."
                    )
    return problems


def check_script() -> list[str]:
    problems = []
    if not VAULT_SH.is_file():
        return [f"missing {VAULT_SH}"]
    text = VAULT_SH.read_text(encoding="utf-8")
    if "assert_safe_to_revoke()" not in text:
        problems.append(
            "scripts/vault.sh: assert_safe_to_revoke is not defined. The workflow "
            "ordering alone cannot cover `vault.sh revoke-root` run by hand."
        )
        return problems
    # Both revoke sites must be guarded, checked per function body.
    for fn in ("cmd_revoke_root", "cmd_bootstrap_approles"):
        m = re.search(rf"^{fn}\(\)\s*\{{(.*?)^\}}", text, re.S | re.M)
        if not m:
            problems.append(f"scripts/vault.sh: {fn} not found")
            continue
        body = m.group(1)
        revokes = "token revoke -self" in body
        if revokes and "assert_safe_to_revoke" not in body:
            problems.append(
                f"scripts/vault.sh: {fn} revokes a root token without calling "
                f"assert_safe_to_revoke first — that path can close the door."
            )
    return problems


def main() -> int:
    problems: list[str] = []
    wfs = sorted(WORKFLOWS.glob("*.yml"))
    if not wfs:
        print("FAIL — no workflows found; the check would pass vacuously.", file=sys.stderr)
        return 1
    for wf in wfs:
        problems += check_workflow(wf)
    problems += check_script()

    for wf in wfs:
        for job, job_text in split_jobs(wf.read_text(encoding="utf-8")):
            verbs = [v for _, vs in steps_with_verbs(job_text) for v in vs]
            if verbs:
                print(f"  {wf.name} [{job}]: {' -> '.join(verbs)}")

    if problems:
        print("\nFAIL — a revoke can precede OIDC being enabled:\n", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        print(
            "\nEnable OIDC before any revoke, or make the revoke refuse. "
            "See docs/runbooks/openbao-rebuild.md.",
            file=sys.stderr,
        )
        return 1

    print("\nPASS — no path reaches a root revoke with OIDC not yet enabled.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
