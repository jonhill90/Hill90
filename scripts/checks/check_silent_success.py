#!/usr/bin/env python3
"""Find operations that can fail and report success.

    python3 scripts/checks/check_silent_success.py

WHY. Five members of this family were closed on 2026-08-03 — all found REACTIVELY,
after two of them caused a 43-minute auth outage and a Grafana SSO breakage. The
pattern is written up in CONTRIBUTING.md under "The Other Half". This check goes
looking for the next one instead of waiting for it.

SHAPES IT DETECTS
=================

A. A CALL SWALLOWED LEFT OF A FALLBACK. `set -e` is suppressed inside a compound
   command on the left of `||`, and every vault-first deploy is shaped
   `( ... ) || { sops fallback }`. A script invoked in there without `|| exit 1`
   can `die`, print its refusal, and the deploy carries on to `docker compose up`.
   That is #671 exactly, and it is why the Alertmanager config silently stopped
   being re-rendered for two days.

B. A CLEANUP OR ASSERTION STEP THAT SKIPS ON FAILURE. In GitHub Actions a custom
   `if:` does not replace the implicit `success()` — it is ANDed with it unless
   the expression names always(), failure() or cancelled(). So a cleanup gated on
   an input runs only when nothing has failed, which is the inverse of its
   purpose. That is #663: a live root token left on production by the runs that
   went wrong.

WHAT IT DOES NOT DETECT, said plainly so the green does not overclaim:

  * A function that returns 0 on a path where it did nothing. Deciding whether
    `return 0` is correct idempotence ("already unsealed") or a silent no-op
    needs judgement about intent, and a regex that guessed would be noise. Two
    real instances found by hand in the 2026-08-03 sweep are listed in the
    allowlist below with their issue.
  * A check that reports on what it read rather than on what it needed. That is
    semantic — `loaded 1 variables, none empty` was true.
  * Anything in a language other than shell or GitHub Actions YAML.

DELIBERATE CASES go in ALLOWLIST with a reason. Silence is a failure; an entry is
a decision.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]

# --- shape A ---------------------------------------------------------------
# Calls inside a fallback subshell that are allowed to fail without aborting.
ALLOWLIST_A = {
    ("deploy.sh", "docker compose"): (
        "compose build/pull/up. `up` is the subshell's last command so its status "
        "propagates; build and pull failing without aborting is tracked separately."
    ),
}

# --- shape B ---------------------------------------------------------------
# Steps whose name reads like cleanup/assertion but whose skip-on-failure is correct.
ALLOWLIST_B = {
    ("reusable-deploy-service.yml", "Prove every alert rule matches a live series"): (
        "a VERIFICATION, not a cleanup — same reasoning as the two entries below. "
        "success() is correct: verifying a deploy that did not happen proves "
        "nothing. Matched on the word 'Prove'."
    ),
    ("reusable-deploy-service.yml", "Prove no MinIO policy collides with an automatic realm role"): (
        "a VERIFICATION, not a cleanup — same reasoning as the Grafana entry "
        "below. success() is correct: verifying a deploy that did not happen "
        "proves nothing. Matched on the word 'Prove'."
    ),
    ("reusable-deploy-service.yml", "Prove Grafana SSO still yields the expected role"): (
        "a VERIFICATION, not a cleanup. success() is correct here: verifying a "
        "deploy that did not happen proves nothing and would fail for the wrong "
        "reason. The rule this check enforces is about CLEANUP — a revoke, a "
        "restore, an assertion about disposal — which must survive a failed run. "
        "Matched on the word 'Prove'."
    ),
    ("vault-regain-root.yml", "Refuse without the typed confirmation"): (
        "the FIRST step of the job — nothing can have failed before it, so the "
        "implicit success() is unreachable. Matched on the word 'Refuse'."
    ),
    ("reusable-deploy-service.yml", "Prove no retired role is granted anything, on the live estate"): (
        "a VERIFICATION, not a cleanup — same reasoning as the MinIO and "
        "Grafana entries above (h#738). success() is correct: verifying a "
        "deploy that did not happen proves nothing. Matched on the word "
        "'Prove'."
    ),
}

CLEANUP_WORDS = re.compile(
    r"revoke|cleanup|clean up|restore|assert|confirm|verify|prove|teardown|"
    r"remove|shut|report where",
    re.I,
)
STATUS_FNS = ("always(", "failure(", "cancelled(")


def shape_a() -> list[str]:
    """Bare script invocations inside a `( ... ) || {` subshell."""
    problems: list[str] = []
    for path in sorted((ROOT / "scripts").glob("*.sh")):
        lines = path.read_text().splitlines()
        depth_start = None
        for i, ln in enumerate(lines):
            if re.match(r"^\s*\($", ln):
                depth_start = i
                continue
            if depth_start is not None and re.match(r"^\s*\)\s*\|\|", ln):
                block = lines[depth_start + 1 : i]
                for j, stmt in enumerate(block, start=depth_start + 2):
                    s = stmt.strip()
                    if not s or s.startswith("#"):
                        continue
                    # Only flag invocations of another script: those are the ones
                    # that carry their own guards and can `die`.
                    if not re.match(r'^bash\s+"\$SCRIPT_DIR/', s):
                        continue
                    if "|| exit" in s:
                        continue
                    key = next(
                        (k for k in ALLOWLIST_A if k[0] == path.name and k[1] in s), None
                    )
                    if key:
                        continue
                    problems.append(
                        f"{path.name}:{j} — `{s}` runs inside a `( ... ) || fallback` "
                        f"subshell with no `|| exit 1`. If it refuses, the refusal is "
                        f"discarded and the deploy continues."
                    )
                depth_start = None
    return problems


def shape_b() -> list[str]:
    problems: list[str] = []
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
        try:
            doc = yaml.safe_load(path.read_text())
        except yaml.YAMLError as e:
            problems.append(f"{path.name} is not valid YAML: {e}")
            continue
        if not isinstance(doc, dict):
            continue
        for job, jd in (doc.get("jobs") or {}).items():
            for i, step in enumerate(jd.get("steps") or [], start=1):
                cond = step.get("if")
                if cond is None:
                    continue
                if any(fn in str(cond) for fn in STATUS_FNS):
                    continue
                name = step.get("name", "(unnamed)")
                if not CLEANUP_WORDS.search(name):
                    continue
                if (path.name, name) in ALLOWLIST_B:
                    continue
                problems.append(
                    f"{path.name}:{job} step {i} — {name!r} reads as cleanup or an "
                    f"assertion but its condition `{cond}` is ANDed with the implicit "
                    f"success(), so it is SKIPPED exactly when the run fails."
                )
    return problems


# KNOWN, TRACKED, NOT YET FIXED. Found by the 2026-08-03 proactive sweep and
# recorded so CI stays usable while they are fixed in their own changes.
#
# THIS IS NOT AN ALLOWLIST. An allowlist says "this is fine"; a baseline says
# "this is a defect we have named and not yet closed". A baseline entry that no
# longer matches is ALSO a failure — otherwise a fix leaves dead scaffolding and
# the next reader cannot tell which entries are real.
# EMPTY, and that is the point: every finding the sweep made has been fixed and
# its entry removed in the same change. deploy.sh:236/:243 went with #676; the
# two workflow conditions went with this one. An entry left behind after a fix
# fails as stale, which is what keeps this honest rather than decorative.
BASELINE: dict[str, str] = {}


def split_baseline(problems: list[str]) -> tuple[list[str], list[str]]:
    known, new = [], []
    for p in problems:
        if any(p.startswith(k) or p.startswith(k.split(" — ")[0]) for k in BASELINE):
            known.append(p)
        else:
            new.append(p)
    return known, new


def main() -> int:
    print("Operations that can fail and report success")
    print("===========================================")

    a = shape_a()
    print(f"\n  A. swallowed inside a fallback subshell: {len(a)}")
    for p in a:
        print(f"     {p}")

    b = shape_b()
    print(f"\n  B. cleanup/assertion skipped on failure: {len(b)}")
    for p in b:
        print(f"     {p}")

    print(f"\n  allowlisted as deliberate: A={len(ALLOWLIST_A)} B={len(ALLOWLIST_B)}")

    known, new = split_baseline(a + b)
    print(f"\n  known and tracked (baseline): {len(known)}")
    print(f"  allowlisted as deliberate:    A={len(ALLOWLIST_A)} B={len(ALLOWLIST_B)}")

    # A baseline entry that no longer matches anything is stale scaffolding.
    matched = {k for k in BASELINE for p in (a + b) if p.startswith(k.split(" — ")[0])}
    stale = sorted(set(BASELINE) - matched)
    for s in stale:
        print(f"  STALE baseline entry (fixed?): {s}")

    if new or stale:
        print(f"\nFAIL — {len(new)} new finding(s), {len(stale)} stale baseline entr(ies).")
        for p in new:
            print(f"  NEW: {p}")
        if stale:
            print("  A fixed finding must be REMOVED from BASELINE, or the next reader")
            print("  cannot tell which entries are still real.")
        print("See CONTRIBUTING.md, 'The Other Half: An Operation That Fails and")
        print("Reports Success'. If a case is deliberate, add it to ALLOWLIST with a")
        print("reason — silence is a failure, an entry is a decision.")
        return 1

    print("\nPASS — no NEW instance beyond the tracked baseline")
    print("  (shape C and D are not machine-detectable — see the module docstring)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
