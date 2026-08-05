#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_dispatch_targets_one_service.py.
#
# The check reads one file and looks for one line, which is exactly the shape
# that passes forever once the line is deleted. Every test below moves the
# workflow and REQUIRES red — including the pre-fix text verbatim, so the
# control is anchored to the defect that actually happened rather than to a
# rule someone wrote down afterwards.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/.github/workflows"
  cp "$ROOT/scripts/checks/check_dispatch_targets_one_service.py" "$CTL/scripts/checks/"
  cp "$ROOT/.github/workflows/deploy.yml" "$CTL/.github/workflows/"
  CHECK="$CTL/scripts/checks/check_dispatch_targets_one_service.py"
  WF="$CTL/.github/workflows/deploy.yml"
}

@test "CONTROL: passes on the real tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

# THE ACTUAL DEFECT, replayed: the step as it stood before this fix, with no
# `if` at all. Run 31040415190 deployed all five services from `-f service=auth`.
@test "the pre-fix step — no gate at all — is caught" {
  python3 - "$WF" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
t2 = re.sub(r"(- uses: dorny/paths-filter@v3\n        id: filter\n)        if: [^\n]*\n",
            r"\1", t, count=1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not gated against workflow_dispatch"* ]]
}

# A gate with the comparison the wrong way round runs change detection on
# dispatch and NOTHING else — worse than the defect, and it reads as fixed.
@test "an inverted gate is caught, not accepted as 'mentions workflow_dispatch'" {
  python3 - "$WF" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("if: github.event_name != 'workflow_dispatch'",
               "if: github.event_name == 'workflow_dispatch'", 1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not one that excludes it"* ]]
}

# Gating on the wrong event satisfies a naive "contains workflow_dispatch" test
# while leaving dispatch fully exposed.
@test "a gate on some other event is caught" {
  python3 - "$WF" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("if: github.event_name != 'workflow_dispatch'",
               "if: github.event_name != 'schedule'", 1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
}

# Blindness must not read as health. If the step is renamed away, the check has
# nothing to measure and has to say so — the 0-inputs-scanned trap.
@test "a missing paths-filter step is CANNOT DETERMINE, not a pass" {
  python3 - "$WF" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("dorny/paths-filter", "some-other/change-detector")
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 2 ]
  [[ "$output" == *"CANNOT DETERMINE"* ]]
}

# WIRING, not logic (h#736/h#758): every test above proves the check's logic.
# None of them prove anything ever runs it.
@test "ci.yml genuinely invokes this check, not just mentions it" {
  run grep -n "run: python3 scripts/checks/check_dispatch_targets_one_service.py" \
    "$ROOT/.github/workflows/ci.yml"
  [ "$status" -eq 0 ]
}
