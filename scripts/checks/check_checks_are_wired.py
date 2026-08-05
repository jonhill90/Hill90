#!/usr/bin/env python3
"""Every check in scripts/checks must be invoked by something REAL.

    python3 scripts/checks/check_checks_are_wired.py

WHY. A check nobody calls is indistinguishable from a check that always passes.
On 2026-08-03 five of thirty-one were invoked by nothing — including
`grafana-role-login-test.sh`, written that morning to prove Grafana's role
mapping, which would have caught the SSO breakage from earlier the same day and
was attached to nothing (#688, #689).

The inventory that found them was an ad-hoc script run by hand. This makes the
result an invariant instead: a new check that nobody wires fails the pull request
that adds it.

REAL vs TEST-ONLY (Hill90#736), the distinction this file exists to draw and
for four attempts did not:
======================================================================
A bats control or a pytest test PROVES a check behaves correctly when it is
run, against a fixture built for the purpose. It does NOT prove anything ever
runs that check in CI or in a deploy path — a check whose only caller, in the
entire repository, is its own test harness has never once been evaluated
against real state. That is the exact blind spot this file exists to catch,
one level up: "wired" must mean a workflow step, the Makefile, or another
script actually invokes the check — not merely that a test proves the check
would behave if something did.

So there are three outcomes per check, not two:
  REAL       — invoked by a workflow step, the Makefile, or another script.
  TEST-ONLY  — invoked ONLY by a bats control and/or a pytest test. The
               check's logic is proven correct; nothing runs it for real.
  ORPHAN     — invoked by nothing at all, not even a test.
Only REAL passes. TEST-ONLY and ORPHAN both fail, reported separately, because
a check nobody runs for real is exactly as decorative as a check nobody runs
at all — the difference is only in how convincing the illusion of coverage is.

HOW THE CLASSIFIER IS WRITTEN, and why each rule is there. Getting the mention
vs. invocation distinction right took four attempts and the first three were
confidently wrong:

  * MENTION IS NOT INVOCATION. `minio.sh` prints "Verify with: …
    minio-policy-names-test.sh" and `ci.yml` echoes "python3 …
    check_alert_series.py (run on the VPS)". Both name a check they never run,
    and a plain `grep -rl` counted them as wired. So lines that are comments, or
    that run through echo/printf, do not count. This still applies to REAL
    sources (workflow, Makefile, script) — it is orthogonal to the REAL vs
    TEST-ONLY split above, which is about WHICH source hit, not HOW it hit.

  * BATS IS DIFFERENT, AND MUST BE, FOR HOW IT MATCHES. A control copies the
    check into a temp tree and runs it through a variable — `python3 "$CHECK"`
    — so the check's name never appears on the invocation line. Requiring an
    invocation pattern there reported every bats-gated check as an orphan. For
    .bats files a mention IS the evidence that a control exists — it is just
    evidence of a TEST now, not of real wiring.

  * PYTEST HAS THE SAME BLIND SPOT AS BATS, for the same reason. Every check's
    pytest file in this repo uses the identical shape — `subprocess.run([...,
    str(SCRIPT)])` — to invoke the check as a CLI under a fabricated fixture.
    That is a control, not a production caller, even though `pytest tests/checks/`
    itself genuinely runs in CI (ci.yml). The check being invoked by a test
    suite that CI runs is still not the check being invoked for real; only
    proof that the test suite's own assertions about the check keep passing.

  * A CI LOG PROVES PRESENCE, NOT ABSENCE. Searching a run's log for each check's
    banner looked authoritative and is one-directional: bats suppresses the
    output of passing tests, so absence from the log means nothing. It also
    promoted `check_alert_series.py` to "runs" purely because CI echoed its name.
    No log is consulted here.

WHAT THIS DOES NOT CHECK: whether the invocation is in a useful place, whether
the check can fail, or whether it asserts anything worthwhile. `check_silent_success.py`
covers the second. Nothing covers the first or third, and this green should not
be read as covering them either.

Exit 0 if every check has a REAL caller.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECKS = ROOT / "scripts/checks"

# Categories that prove a check is invoked FOR REAL — a workflow step, the
# Makefile, or another script. A hit in any of these is enough to pass.
REAL_SOURCES = ("workflow", "Makefile", "script")

# Categories that only prove a TEST exists for the check — a bats control or
# a pytest test invoking it as a CLI under a fabricated fixture. Necessary,
# not sufficient: see the module docstring's REAL vs TEST-ONLY section.
TEST_SOURCES = ("bats", "pytest")

# Checks deliberately not invoked FOR REAL, with the reason. An entry is a
# decision; silence is a failure. Empty is the goal state, not the current
# one: h#736's fix found 8 checks wired only to their own bats/pytest
# control — proven correct under test, never once run against real state.
# Tracked in h#758, NOT declared fine to stay this way — each entry below is
# an acknowledgment of a known gap, not a decision that it is acceptable
# forever.
ALLOWLIST: dict[str, str] = {
    "check_realm_tenant_clients.py": "test-only, found by h#736 — tracked in h#758",
    "check_role_mappings_repointed.py": "test-only, found by h#736 — tracked in h#758",
    "check_silent_success.py": "test-only, found by h#736 — tracked in h#758",
    "check_vault_covers_compose.py": "test-only, found by h#736 — tracked in h#758",
    "realm-tenant-serves-test.sh": "test-only, found by h#736 — tracked in h#758",
    "tenant-login-local-test.sh": "test-only, found by h#736 — tracked in h#758",
}


def sources() -> dict[str, list[Path]]:
    return {
        "bats": sorted((ROOT / "tests").rglob("*.bats")),
        "pytest": sorted((ROOT / "tests").rglob("*.py")),
        "workflow": sorted((ROOT / ".github/workflows").glob("*.yml")),
        "Makefile": [ROOT / "Makefile"] if (ROOT / "Makefile").exists() else [],
        "script": sorted((ROOT / "scripts").rglob("*.sh")),
    }


def invokes(text: str, name: str) -> bool:
    """Does this file RUN the named check, as opposed to mentioning it?"""
    for line in text.splitlines():
        if name not in line:
            continue
        s = line.strip()
        if s.startswith("#"):
            continue
        if re.match(r"^(echo|printf)\b", s):
            continue
        if re.search(r"\b(echo|printf)\b.*" + re.escape(name), s):
            continue
        return True
    return False


def main() -> int:
    names = sorted(
        p.name for p in CHECKS.iterdir() if p.suffix in (".py", ".sh") and p.is_file()
    )
    if not names:
        print("no checks found under scripts/checks — refusing to report success")
        return 1

    src = sources()
    rows: list[tuple[str, list[str], list[str]]] = []
    for name in names:
        real: list[str] = []
        test: list[str] = []
        for cat, files in src.items():
            for f in files:
                if f.name == name:
                    continue
                try:
                    text = f.read_text()
                except (OSError, UnicodeDecodeError):
                    continue
                hit = (name in text) if cat == "bats" else invokes(text, name)
                if hit:
                    (real if cat in REAL_SOURCES else test).append(cat)
                    break
        rows.append((name, real, test))

    test_only = [n for n, r, t in rows if not r and t and n not in ALLOWLIST]
    orphans = [n for n, r, t in rows if not r and not t and n not in ALLOWLIST]
    allowed = [n for n, r, t in rows if not r and n in ALLOWLIST]
    wired = len(rows) - len(test_only) - len(orphans) - len(allowed)

    print("Every check must be invoked by something REAL")
    print("===============================================")
    for name, real, test in rows:
        if real:
            mark = "ok  "
        elif name in ALLOWLIST:
            mark = "note"
        elif test:
            mark = "TEST"
        else:
            mark = "MISS"
        where = ",".join(real) if real else (",".join(test) if test else "(nothing)")
        print(f"  {mark}  {name:<42} {where}")

    print(f"\n  {len(rows)} checks, {wired} invoked for real, "
          f"{len(test_only)} test-only, {len(allowed)} allowlisted, "
          f"{len(orphans)} orphaned")

    for n in allowed:
        print(f"  allowlisted: {n} — {ALLOWLIST[n]}")

    if test_only:
        print(f"\nFAIL — {len(test_only)} check(s) proven correct by a test but never run for real:\n")
        for n in test_only:
            print(f"  {n}")
        print(
            "\nA bats control or a pytest test proves the check behaves correctly\n"
            "when invoked against a fabricated fixture. It does not prove anything\n"
            "in CI or a deploy path ever runs it against real state — which is the\n"
            "exact blind spot this file exists to catch, one level up. Wire it into\n"
            "a workflow step, the Makefile, or another real script — or retire it\n"
            "(#694), or allowlist it here with the reason it is deliberately\n"
            "test-only forever."
        )

    if orphans:
        print(f"\nFAIL — {len(orphans)} check(s) invoked by nothing, not even a test:\n")
        for n in orphans:
            print(f"  {n}")
        print(
            "\nA check nobody calls is indistinguishable from a check that always\n"
            "passes. Wire it into a bats control, a pytest test, a workflow, the\n"
            "Makefile or a script — or retire it, which is also a valid answer (see\n"
            "#694 for the property-by-property gate a retirement should satisfy).\n"
            "If it is deliberately manual, add it to ALLOWLIST here with the reason."
        )

    if test_only or orphans:
        return 1

    print("\nPASS — every check has a real caller")
    print("  (this says nothing about whether the invocation is in a useful place,")
    print("   or whether the check can fail — see the module docstring)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
