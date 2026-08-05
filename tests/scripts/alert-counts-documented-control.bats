#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_alert_counts_documented.py.
#
# The defect: CLAUDE.md said "16 rules, 8 groups" while Prometheus loaded 18 in 9.
# Counted before #617 and never re-counted — not stale, WRONG, and nothing could
# notice. These tests move each side independently and require red, because a
# comparison that passes no matter what either side says is not a comparison.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/platform/observability/prometheus"
  cp "$ROOT/scripts/checks/check_alert_counts_documented.py" "$CTL/scripts/checks/"
  cp "$ROOT/platform/observability/prometheus/alerts.yml" "$CTL/platform/observability/prometheus/"
  cp "$ROOT/CLAUDE.md" "$CTL/"
  CHECK="$CTL/scripts/checks/check_alert_counts_documented.py"

  # Today's real counts, measured here rather than written in as literals.
  #
  # They used to be hardcoded as 18 and 9, which meant every alert rule added
  # to the estate turned this control red — h#712 added a group of eight and
  # four tests failed on numbers that were never the thing under test. A
  # control that has to be edited whenever the subject changes teaches people
  # to edit controls.
  #
  # Deliberately measured with grep, not by parsing YAML: the check under test
  # parses YAML, and a control that re-derives its expectation the same way the
  # subject does is comparing a method against itself. Two methods against one
  # file is a real second opinion; the same method twice is one measurement.
  ALERTS="$ROOT/platform/observability/prometheus/alerts.yml"
  REAL_RULES=$(grep -c '^[[:space:]]*- alert:' "$ALERTS")
  REAL_GROUPS=$(grep -c '^[[:space:]]*- name:' "$ALERTS")
}

@test "CONTROL: passes on the real tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "CONTROL: it reports real numbers, not zeros" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  # A 0/0 == 0/0 agreement would pass while measuring nothing.
  [[ "$output" != *"0 rules in 0 groups"* ]]
  [[ "$output" == *"$REAL_RULES rules in $REAL_GROUPS groups"* ]]
}

# THE ACTUAL 2026-08-03 DEFECT, replayed: the document lags the rules.
@test "the shipped 16/8 wording — the real defect — is caught" {
  python3 - "$CTL/CLAUDE.md" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
# \s+ not a literal space: the sentence wraps across a line in CLAUDE.md,
# which is why a first version of this mutation silently matched nothing.
t2 = re.sub(r"\*\*\d+\s+rules\s+in\s+\d+\s+groups\*\*", "**16 rules in 8 groups**", t, count=1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"file has $REAL_RULES, CLAUDE.md claims 16"* ]]
  [[ "$output" == *"file has $REAL_GROUPS, CLAUDE.md claims 8"* ]]
}

# The other direction: someone adds a rule and does not touch the sentence.
@test "adding a rule without updating the sentence is caught" {
  python3 - "$CTL/platform/observability/prometheus/alerts.yml" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
d["groups"][0].setdefault("rules", []).append(
    {"alert": "ControlOnlyRule", "expr": "vector(0)", "labels": {"severity": "none"}}
)
yaml.safe_dump(d, open(p, "w"))
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"file has $((REAL_RULES + 1)), CLAUDE.md claims $REAL_RULES"* ]]
}

# Adding a GROUP too, so both dimensions are exercised rather than just one.
@test "adding a group without updating the sentence is caught" {
  python3 - "$CTL/platform/observability/prometheus/alerts.yml" <<'PY'
import sys, yaml
p = sys.argv[1]
d = yaml.safe_load(open(p))
d["groups"].append({"name": "control-only", "rules": [
    {"alert": "ControlOnlyRule", "expr": "vector(0)"}]})
yaml.safe_dump(d, open(p, "w"))
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"file has $((REAL_GROUPS + 1)), CLAUDE.md claims $REAL_GROUPS"* ]]
}

# A check that cannot find its target must FAIL, not pass. Otherwise deleting the
# sentence silently retires the guard — which is how the original number survived.
@test "removing the sentence from CLAUDE.md fails rather than passing" {
  python3 - "$CTL/CLAUDE.md" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
t2 = re.sub(r"\*\*\d+\s+rules\s+in\s+\d+\s+groups\*\*", "(counts removed)", t, count=1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"no '**N rules in M groups**' sentence"* ]]
}

# WIRING, not logic (h#736/h#758): every test above proves the check's LOGIC
# is correct. None of them prove anything ever RUNS it — before this fix,
# this check's only caller anywhere was this bats file, which is exactly the
# TEST-ONLY outcome h#736 taught check_checks_are_wired.py to catch. This
# check is fully hermetic (no network, no live host — see its own
# docstring), so unlike h#738 there was no design question about WHERE it
# could run: ci.yml, on every PR, same as check_md_links.py right above it.
@test "h#758: ci.yml genuinely invokes this check, not just mentions it" {
  run grep -n "run: python3 scripts/checks/check_alert_counts_documented.py" \
    "$ROOT/.github/workflows/ci.yml"
  [ "$status" -eq 0 ]
}

@test "an alerts file with no groups fails rather than reporting 0 == 0" {
  python3 - "$CTL/platform/observability/prometheus/alerts.yml" <<'PY'
import sys, yaml
p = sys.argv[1]
yaml.safe_dump({"groups": []}, open(p, "w"))
PY

  run python3 "$CHECK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"declares no groups"* ]]
}
