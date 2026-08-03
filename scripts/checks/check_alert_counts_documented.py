#!/usr/bin/env python3
"""CLAUDE.md's alert counts must match the rules the repository ships.

    python3 scripts/checks/check_alert_counts_documented.py

WHY THIS EXISTS. On 2026-08-03 CLAUDE.md said "16 rules, 8 groups". Prometheus
was loading 18 in 9. The numbers were counted before #617 and never re-counted,
so the entry was not stale — it was WRONG, and nothing could notice. CLAUDE.md is
the first file a cold session reads, and a wrong number there is worse than no
number, because it is quoted rather than checked.

WHY IT IS HERMETIC RATHER THAN ASKING PROMETHEUS. The obvious version compares
the document against the live Prometheus. That version cannot run in CI — there
is no Prometheus on a runner — so it would only run when somebody remembered to
run it, which is the failure it exists to prevent. A guard that depends on being
remembered is the same class of defect as the one it guards.

Prometheus loads what this repository ships: `platform/observability/prometheus/alerts.yml`
is bind-mounted into the container. Measured 2026-08-03, repo and live agree
exactly at 9 groups and 18 rules. So counting the file is counting what runs, it
needs no network, and it fails at the moment a rule is added — in the pull
request that adds it, next to the person who can fix the sentence.

WHAT IT DOES NOT CHECK, stated so its green is not read too widely:

  * That the rules can FIRE. A rule matching a label production never emits is
    `health=ok` and useless — two shipped that way. That is
    `scripts/checks/check_alert_series.py`, which must run against the live
    Prometheus and cannot be hermetic.
  * That alerts REACH anyone. Delivery is proven by firing one and reading
    Alertmanager's counters, not by counting rules.
  * Anything about Alertmanager's routing, receivers or templates.

It checks one sentence against one file. That is the whole scope, and it is worth
it only because that sentence was wrong and nobody could tell.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
ALERTS = ROOT / "platform/observability/prometheus/alerts.yml"
DOC = ROOT / "CLAUDE.md"

# The sentence in CLAUDE.md, e.g. "**18 rules in 9 groups**".
DOC_PATTERN = re.compile(r"\*\*(\d+)\s+rules?\s+in\s+(\d+)\s+groups?\*\*", re.I)


def counted_from_repo() -> tuple[int, int]:
    if not ALERTS.exists():
        sys.exit(f"missing {ALERTS.relative_to(ROOT)} — cannot count what ships")
    doc = yaml.safe_load(ALERTS.read_text())
    groups = doc.get("groups") or []
    if not groups:
        sys.exit(f"{ALERTS.relative_to(ROOT)} declares no groups — refusing to "
                 "report 0/0 as agreement with anything")
    return sum(len(g.get("rules") or []) for g in groups), len(groups)


def counted_from_doc() -> tuple[int, int]:
    m = DOC_PATTERN.search(DOC.read_text())
    if not m:
        sys.exit(
            "CLAUDE.md has no '**N rules in M groups**' sentence.\n"
            "This check compares that sentence against the shipped rules; if the\n"
            "wording changed, update DOC_PATTERN here rather than deleting the\n"
            "number — an unchecked number is how it went wrong the first time."
        )
    return int(m.group(1)), int(m.group(2))


def main() -> int:
    repo_rules, repo_groups = counted_from_repo()
    doc_rules, doc_groups = counted_from_doc()

    print("Documented alert counts vs the rules that ship")
    print("==============================================")
    print(f"  {ALERTS.relative_to(ROOT)}: {repo_rules} rules in {repo_groups} groups")
    print(f"  CLAUDE.md says:            {doc_rules} rules in {doc_groups} groups")
    print()

    if (repo_rules, repo_groups) == (doc_rules, doc_groups):
        print("PASS — the documented counts match what the repository ships")
        print("  (this says nothing about whether the rules can fire, or whether")
        print("   anyone receives them — see the module docstring)")
        return 0

    print("FAIL — CLAUDE.md disagrees with the shipped rules.\n")
    if repo_rules != doc_rules:
        print(f"  rules:  file has {repo_rules}, CLAUDE.md claims {doc_rules}")
    if repo_groups != doc_groups:
        print(f"  groups: file has {repo_groups}, CLAUDE.md claims {doc_groups}")
    print(
        "\nCLAUDE.md is the first file a cold session reads, so a wrong number there\n"
        "is quoted rather than checked. Update the sentence in the same change that\n"
        "adds or removes the rule."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
