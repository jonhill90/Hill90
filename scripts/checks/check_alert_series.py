#!/usr/bin/env python3
"""Ask the LIVE Prometheus whether each alert rule's selectors match anything.

    bash -c 'cd /opt/hill90/app && python3 scripts/checks/check_alert_series.py'

WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS.

tests/prometheus/alerts_test.yml proves a rule's logic. It cannot prove the
series exist, because the test author supplies the input series and can invent
any label the rule asks for. Two rules shipped here with that defect:

  LokiIngestionErrors      matches {status="error"}; the metric has no `status`
                           label, and `error` is not a value it takes anywhere
  HighMemoryUsage          annotated {{ $labels.name }}; cAdvisor emits no `name`

Both evaluated cleanly, both reported health=ok, neither could ever fire. From
the alert list that is indistinguishable from everything being fine.

This check closes that gap by asking the running Prometheus. It must be run
against production (or a live local stack) — it is deliberately NOT in CI, which
has no Prometheus to ask. That is the point: the two checks are complementary
and neither is sufficient alone.

Read-only: instant queries only. Nothing is written, enabled or restarted.

A selector that is legitimately absent — a counter created only when the
condition first occurs, or a metric whose emitter is not built yet — is declared
in scripts/checks/alert-series-allowlist.txt, with a reason.

Exit 0 if every selector matches, or is declared absent. Exit 1 otherwise —
including when an allowlist entry has gone STALE (see below).

WHY THE ALLOWLIST ITSELF IS CHECKED, NOT JUST THE RULES (h#841). An entry
declaring a selector "legitimately absent" is a claim about the present, and
claims about the present go stale. h#839 added one for
shared-secret-agreement's heartbeat metric, correct when written — that
workflow had never run. Dispatching it once made the entry wrong within the
hour: the metric existed, the allowlist still said it wouldn't. Nothing
caught that automatically; it was found by a human re-running this script by
hand and noticing the entry no longer applied.

The fix is not a per-entry expiry date. A date only bounds how long a wrong
entry can survive on an arbitrary calendar schedule that has nothing to do
with when the underlying condition actually changed — it would not have
caught the shared-secret-agreement case any faster than the human did, and
every entry would need one hand-picked and then maintained. This script
already queries EVERY selector against live Prometheus unconditionally,
allowlisted or not (see the loop below) — the data needed to know an entry
is stale already exists on every single run, for free. So: if a selector
that is ALSO in the allowlist comes back with real series, that is now a
hard failure, not a silently-ignored `ok`. Zero lag, no new bookkeeping, no
date to remember to update.
"""
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")

RULES = Path(__file__).resolve().parents[2] / \
    "platform/observability/prometheus/alerts.yml"
ALLOWLIST = Path(__file__).resolve().parent / "alert-series-allowlist.txt"

# Identifiers that are PromQL, not metrics. Functions are detected by the '('
# that follows them, so this only needs the keywords and bare words.
KEYWORDS = {
    "by", "without", "on", "ignoring", "group_left", "group_right", "offset",
    "bool", "and", "or", "unless", "if", "default", "start", "end", "atan2",
    "inf", "nan",
}

# Applied in order. Each removes a construct whose contents would otherwise be
# mistaken for metric names.
#
# String literals are deliberately NOT stripped. An earlier version removed them
# and turned {job="blackbox-public"} into {job= }, which Prometheus rejects with
# HTTP 400 — and the script reported that as "cannot fire". The label matcher is
# the most important part of the selector to keep: a rule can name a real metric
# and still match nothing because of one wrong label, which is the entire defect
# this check exists to find.
STRIP = [
    re.compile(r"\[[^\]]*\]"),                       # range/subquery selectors
    re.compile(r"\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)"),
]

SELECTOR = re.compile(r"(?<![\w:.])([a-zA-Z_:][\w:]*)\s*(\{[^}]*\})?")


def prometheus_query(expr):
    """Instant query via the container, so no published port is needed and no
    hardcoded IP goes stale when Prometheus is redeployed."""
    url = ("http://localhost:9090/api/v1/query?"
           + urllib.parse.urlencode({"query": expr}))
    p = subprocess.run(
        ["docker", "exec", "prometheus", "wget", "-qO-", url],
        capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        return None, (p.stderr.strip() or "docker exec failed")
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError as e:
        return None, f"unparseable response: {e}"
    if d.get("status") != "success":
        return None, d.get("error", "query rejected")
    return d["data"]["result"], None


def selectors_in(expr):
    """Every metric selector in a PromQL expression, label matchers included.

    The label matchers are the reason this keeps the braces: a rule can name a
    real metric and still match nothing because of one wrong label.
    """
    text = expr
    for pattern in STRIP:
        text = pattern.sub(" ", text)

    found = []
    for m in SELECTOR.finditer(text):
        name, labels = m.group(1), m.group(2) or ""
        # A '(' after the identifier makes it a function call. Skip whitespace
        # first: stripping "by (instance)" out of "sum by (instance) (metric)"
        # leaves "sum  (metric)", and an earlier version checked only the very
        # next character, so it reported `sum` and `max` as missing metrics.
        if text[m.end(1):].lstrip(" \t\n")[:1] == "(":
            continue
        if name in KEYWORDS or name.isdigit():
            continue
        sel = name + labels
        if sel not in found:
            found.append(sel)
    return found


def main():
    raw = RULES.read_text()
    doc = yaml.safe_load(raw)

    allowed = {}
    if ALLOWLIST.exists():
        for line in ALLOWLIST.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            sel, _, reason = line.partition("#")
            allowed[sel.strip()] = reason.strip() or "(no reason given)"

    print(f"Alert rule series check — {RULES}")
    if allowed:
        print(f"declared absent ({ALLOWLIST.name}): {len(allowed)} selector(s)")
    print()

    probe, err = prometheus_query("up")
    if err:
        print(f"CANNOT REACH PROMETHEUS: {err}")
        print("A check that cannot run must not report success. Exiting 1.")
        return 1

    missing, stale_allowlist, checked = [], [], 0
    for group in doc.get("groups", []):
        for rule in group.get("rules", []):
            name = rule.get("alert")
            if not name:
                continue
            print(f"{name}")
            for sel in selectors_in(rule["expr"]):
                base = sel.split("{")[0]
                is_allowlisted = base in allowed or sel in allowed
                res, err = prometheus_query(sel)
                checked += 1
                if err:
                    print(f"    ?  {sel}   (query error: {err})")
                    missing.append((name, sel, "query error"))
                elif res:
                    labels = sorted({k for s in res for k in s["metric"]
                                     if k != "__name__"})
                    print(f"    ok {sel}   {len(res)} series   "
                          f"[{', '.join(labels)}]")
                    if is_allowlisted:
                        # h#841: the entry claimed this could legitimately be
                        # absent, and it is not — the claim is now false, not
                        # merely unneeded. Reported here rather than silently
                        # taking the `ok` branch, because a stale allowlist
                        # entry sitting unused is exactly how one goes
                        # unnoticed for longer than an hour next time.
                        print(f"    !  STALE ALLOWLIST ENTRY: {sel} is listed "
                              f"in {ALLOWLIST.name} as legitimately absent, "
                              f"but {len(res)} series exist right now. Remove "
                              f"the line — the reason it was added no longer "
                              f"applies.")
                        stale_allowlist.append((name, sel))
                elif is_allowlisted:
                    why = allowed.get(sel) or allowed.get(base)
                    print(f"    -  {sel}   0 series — declared absent: {why}")
                else:
                    print(f"    NO {sel}   0 SERIES — this rule cannot fire")
                    missing.append((name, sel, "no series"))
            print()

    print("-" * 70)
    print(f"{checked} selectors checked")
    if missing:
        print(f"\n{len(missing)} SELECTOR(S) MATCH NOTHING:\n")
        for rule, sel, why in missing:
            print(f"  {rule}: {sel}  ({why})")
        print("\nA rule matching no series never fires and looks exactly like")
        print("health. Either correct the selector, delete the rule, or add it")
        print(f"to {ALLOWLIST.name} with a reason.")
        return 1
    if stale_allowlist:
        print(f"\n{len(stale_allowlist)} STALE ALLOWLIST ENTRY(IES):\n")
        for rule, sel in stale_allowlist:
            print(f"  {rule}: {sel}")
        print(f"\nEach of these matches real series now — the reason it was")
        print(f"declared absent in {ALLOWLIST.name} no longer holds. Delete")
        print("those lines; do not leave a claim standing that the data")
        print("itself already contradicts.")
        return 1
    # Deliberately not "every selector matches". Some are declared absent, and a
    # summary line that hides that is the same kind of small lie this whole check
    # exists to catch.
    print("every selector matches a live series, or is declared absent with a reason")
    return 0


if __name__ == "__main__":
    sys.exit(main())
