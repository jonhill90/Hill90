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

h#855 REVIEW — TWO BLIND SPOTS THIS SCRIPT COULD NOT SEE, closed here.
Both were proven with a synthetic rule against the live production
Prometheus before either fix was written — see the PR body, not just this
comment, for the actual output.

1. A selector inside absent(...) was checked with the SAME "0 series = this
   rule cannot fire" rule as everything else. That is backwards for this one
   construct: 0 series is exactly what an absent()-wrapped selector is
   DESIGNED to detect — it is the rule's own firing condition, not evidence
   the rule is broken. The real alerts.yml has six such rules today
   (LokiIngestionStalled/SignalMissing, BackupNotSucceeding*,
   ScheduledWorkflow*) — four of the six currently pass only because the
   underlying metric happens to have series RIGHT NOW; the moment any one of
   them genuinely went absent (a real incident, or a workflow that has never
   fired), the old code would have reported "this rule cannot fire" — false,
   and exactly backwards during the one moment it would matter.
   is_absent_wrapped() below detects the ONE shape this file's own rules
   actually use — `absent(` or `absent_over_time(` directly preceding the
   selector — not a general PromQL parse. A 0-series result for such a
   selector is no longer added to `missing`; it is reported as its own
   category and does not fail the check, because the wrapper is itself the
   author's declaration that absence is a real, meaningful state — the same
   role an allowlist entry plays for every other selector, without needing
   one written by hand for each of the six.

2. A label referenced only via `by (label)` / `without (label)` /
   `on (label)` / `ignoring (label)` / `group_left(label)` /
   `group_right(label)`, or only inside a `{{ $labels.label }}` annotation
   template, was invisible to selector extraction: STRIP deletes the
   by/without/on/ignoring/group_left/group_right clause's contents before
   metric names are ever looked for, and annotations are never read at all.
   So a rule could group or annotate by a label that not one live series of
   its own metric actually carries, and this script would report the bare
   metric as `ok` — exactly the HighMemoryUsage shape cited above, just
   reached through aggregation instead of an explicit `{name="x"}` matcher.
   Closed by extracting every such label per rule and, for each metric
   selector already found in that same rule, checking `<metric>{<label>!=""}`
   through the IDENTICAL query/allowlist/report pipeline every other
   selector already goes through — not a second mechanism.
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

# h#855: the exact shape this file's own rules use — the selector is the
# function's direct argument. Not a general PromQL parse (nested calls, a
# nested rate()/sum() between absent( and the metric, would not match) —
# proportionate to what actually exists in alerts.yml today, same spirit as
# the rest of this script's regex-based extraction rather than a real parser.
ABSENT_WRAPPER = re.compile(r"\babsent(?:_over_time)?\s*\(\s*$")

# h#855: labels referenced for grouping or joining, which STRIP deletes
# wholesale before selectors_in() ever runs. Captured separately, from the
# UNSTRIPPED expression text.
GROUPING_CLAUSE = re.compile(
    r"\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)"
)

# h#855: {{ $labels.name }}-style references in annotation templates. Go
# template whitespace trimming ({{- and -}}) is not special-cased — none of
# this file's annotations use it, and the label name itself is unaffected
# either way.
ANNOTATION_LABEL = re.compile(r"\$labels\.(\w+)")


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
    """Every metric selector in a PromQL expression, label matchers included,
    tagged with whether it is the direct argument of absent()/absent_over_time().

    The label matchers are the reason this keeps the braces: a rule can name a
    real metric and still match nothing because of one wrong label.

    Returns a list of (selector, is_absent_wrapped) tuples, in first-seen
    order, deduplicated on the selector text alone (the same selector text
    always carries the same wrapped-ness within one expression).
    """
    text = expr
    for pattern in STRIP:
        text = pattern.sub(" ", text)

    found = []
    seen = set()
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
        wrapped = bool(ABSENT_WRAPPER.search(text[:m.start()]))
        if sel not in seen:
            seen.add(sel)
            found.append((sel, wrapped))
    return found


def grouping_and_annotation_labels(rule):
    """h#855: labels a rule groups/joins on, or names in an annotation
    template, that selectors_in() cannot see because STRIP deletes the
    grouping clause and annotations are a different YAML field entirely."""
    labels = set()
    for m in GROUPING_CLAUSE.finditer(rule.get("expr", "")):
        for part in m.group(1).split(","):
            part = part.strip()
            if part:
                labels.add(part)
    annotations_blob = " ".join(str(v) for v in (rule.get("annotations") or {}).values())
    labels.update(ANNOTATION_LABEL.findall(annotations_blob))
    return labels


def main():
    raw = RULES.read_text()
    doc = yaml.safe_load(raw)
    alert_rule_count = sum(
        1
        for group in doc.get("groups", [])
        for rule in group.get("rules", [])
        if rule.get("alert")
    )

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

    if not alert_rule_count:
        print("rules file contains no alert rules; refusing vacuous success")
        print("Recording rules are valid Prometheus input, but this check only")
        print("verifies alert rules can match live series. Exiting 1.")
        return 1

    probe, err = prometheus_query("up")
    if err:
        print(f"CANNOT REACH PROMETHEUS: {err}")
        print("A check that cannot run must not report success. Exiting 1.")
        return 1

    missing, stale_allowlist, absent_ok, checked = [], [], [], 0
    for group in doc.get("groups", []):
        for rule in group.get("rules", []):
            name = rule.get("alert")
            if not name:
                continue
            print(f"{name}")

            rule_selectors = selectors_in(rule["expr"])

            # h#855: labels referenced only via grouping/join clauses or an
            # annotation template. Checked against every plain-metric
            # selector this same rule already names — `<metric>{<label>!=""}`
            # — reusing the identical query/allowlist/report path below
            # rather than a second mechanism. Base metric name only (no
            # existing braces): the question is "does this metric EVER carry
            # a non-empty value for this label", independent of whatever
            # other matcher the rule's own selector already applies.
            grouping_labels = grouping_and_annotation_labels(rule)
            if grouping_labels:
                base_metrics = {sel.split("{")[0] for sel, _wrapped in rule_selectors}
                for label in sorted(grouping_labels):
                    for metric in sorted(base_metrics):
                        synthetic = f'{metric}{{{label}!=""}}'
                        rule_selectors.append((synthetic, False))

            for sel, is_absent in rule_selectors:
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
                elif is_absent:
                    # h#855: 0 series for the direct argument of absent()/
                    # absent_over_time() is the rule's own firing condition,
                    # not evidence it is broken — the exact inversion the
                    # old code got wrong. Not a failure. Not silently "ok"
                    # either: still worth a human noticing which selectors
                    # are currently in this state, since it is also what a
                    # genuinely dead selector looks like on every run, not
                    # just the one where it matters.
                    print(f"    ~  {sel}   0 series — inside absent()/"
                          f"absent_over_time(): this IS the rule's firing "
                          f"condition, not a broken selector. If this has "
                          f"NEVER had series, that is still worth checking "
                          f"by hand — this line only proves the shape is "
                          f"correctly designed, not that the name is "
                          f"correctly spelled.")
                    absent_ok.append((name, sel))
                elif is_allowlisted:
                    why = allowed.get(sel) or allowed.get(base)
                    print(f"    -  {sel}   0 series — declared absent: {why}")
                else:
                    print(f"    NO {sel}   0 SERIES — this rule cannot fire")
                    missing.append((name, sel, "no series"))
            print()

    print("-" * 70)
    print(f"{checked} selectors checked")
    if absent_ok:
        print(f"({len(absent_ok)} of those are absent()-wrapped selectors "
              f"with 0 series — expected, not counted as failures; see '~' "
              f"lines above)")
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
