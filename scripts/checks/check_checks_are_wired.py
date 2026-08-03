#!/usr/bin/env python3
"""Every check in scripts/checks must be invoked by something.

    python3 scripts/checks/check_checks_are_wired.py

WHY. A check nobody calls is indistinguishable from a check that always passes.
On 2026-08-03 five of thirty-one were invoked by nothing — including
`grafana-role-login-test.sh`, written that morning to prove Grafana's role
mapping, which would have caught the SSO breakage from earlier the same day and
was attached to nothing (#688, #689).

The inventory that found them was an ad-hoc script run by hand. This makes the
result an invariant instead: a new check that nobody wires fails the pull request
that adds it.

WHAT COUNTS AS INVOKED
======================
A bats control, a pytest test, a workflow, the Makefile, or another script.

HOW THE CLASSIFIER IS WRITTEN, and why each rule is there. Getting this right
took four attempts and the first three were confidently wrong:

  * MENTION IS NOT INVOCATION. `minio.sh` prints "Verify with: …
    minio-policy-names-test.sh" and `ci.yml` echoes "python3 …
    check_alert_series.py (run on the VPS)". Both name a check they never run,
    and a plain `grep -rl` counted them as wired. So lines that are comments, or
    that run through echo/printf, do not count.

  * BATS IS DIFFERENT, AND MUST BE. A control copies the check into a temp tree
    and runs it through a variable — `python3 "$CHECK"` — so the check's name
    never appears on the invocation line. Requiring an invocation pattern there
    reported every bats-gated check as an orphan. For .bats files a mention IS
    the evidence, because that is how the pattern works.

  * A CI LOG PROVES PRESENCE, NOT ABSENCE. Searching a run's log for each check's
    banner looked authoritative and is one-directional: bats suppresses the
    output of passing tests, so absence from the log means nothing. It also
    promoted `check_alert_series.py` to "runs" purely because CI echoed its name.
    No log is consulted here.

WHAT THIS DOES NOT CHECK: whether the invocation is in a useful place, whether
the check can fail, or whether it asserts anything worthwhile. `check_silent_success.py`
covers the second. Nothing covers the first or third, and this green should not
be read as covering them either.

Exit 0 if every check is invoked by something.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECKS = ROOT / "scripts/checks"

# Checks deliberately not invoked, with the reason. An entry is a decision;
# silence is a failure. Empty is the goal state and currently the real one.
ALLOWLIST: dict[str, str] = {}


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
    rows: list[tuple[str, list[str]]] = []
    for name in names:
        where: list[str] = []
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
                    where.append(cat)
                    break
        rows.append((name, where))

    orphans = [n for n, w in rows if not w and n not in ALLOWLIST]
    allowed = [n for n, w in rows if not w and n in ALLOWLIST]

    print("Every check must be invoked by something")
    print("========================================")
    for name, where in rows:
        mark = "ok  " if where else ("note" if name in ALLOWLIST else "MISS")
        print(f"  {mark}  {name:<42} {','.join(where) or '(nothing)'}")

    print(f"\n  {len(rows)} checks, {len(rows) - len(orphans) - len(allowed)} invoked, "
          f"{len(allowed)} allowlisted, {len(orphans)} orphaned")

    for n in allowed:
        print(f"  allowlisted: {n} — {ALLOWLIST[n]}")

    if orphans:
        print(f"\nFAIL — {len(orphans)} check(s) invoked by nothing:\n")
        for n in orphans:
            print(f"  {n}")
        print(
            "\nA check nobody calls is indistinguishable from a check that always\n"
            "passes. Wire it into a bats control, a pytest test, a workflow, the\n"
            "Makefile or a script — or retire it, which is also a valid answer (see\n"
            "#694 for the property-by-property gate a retirement should satisfy).\n"
            "If it is deliberately manual, add it to ALLOWLIST here with the reason."
        )
        return 1

    print("\nPASS — no check is invoked by nothing")
    print("  (this says nothing about whether the invocation is in a useful place,")
    print("   or whether the check can fail — see the module docstring)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
