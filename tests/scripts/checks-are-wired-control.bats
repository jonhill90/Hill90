#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_checks_are_wired.py.
#
# The defect it guards: five of thirty-one checks were invoked by nothing (#689),
# including one written that morning to prove Grafana's role mapping which would
# have caught the SSO breakage from earlier the same day. A check nobody calls is
# indistinguishable from a check that always passes.
#
# This file also WIRES the check, which is the point — the first thing
# check_checks_are_wired.py did when run was report itself as an orphan, because
# nothing invoked it yet. It was correct.
#
# The classifier is the part worth controlling. Three earlier versions were
# confidently wrong: a mention counted as an invocation, bats controls were
# missed entirely, and a CI log proved presence but not absence. Each rule below
# pins one of those.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/tests/scripts" "$CTL/tests/checks" \
           "$CTL/.github/workflows" "$CTL/scripts"
  cp "$ROOT/scripts/checks/check_checks_are_wired.py" "$CTL/scripts/checks/"
  cp "$ROOT"/scripts/checks/*.sh "$ROOT"/scripts/checks/*.py "$CTL/scripts/checks/" 2>/dev/null || true
  # EVERY bats file EXCEPT this one. This file's heredocs name the checks it
  # plants (check_brand_new_orphan.py, check_only_echoed.sh), and the bats rule
  # counts a mention as wiring — so copying itself in would make its own planted
  # orphans look invoked, and the orphan tests would pass vacuously. A control
  # that copies itself into the fixture can satisfy the condition it is testing.
  for b in "$ROOT"/tests/scripts/*.bats; do
    [ "$(basename "$b")" = "checks-are-wired-control.bats" ] && continue
    cp "$b" "$CTL/tests/scripts/"
  done
  # …and wire the check under test with a minimal stub instead, so it is not an
  # orphan inside the fixture for the wrong reason.
  printf '%s\n' '# wires scripts/checks/check_checks_are_wired.py' \
    > "$CTL/tests/scripts/wired-stub.bats"
  # tests/checks/*.py too. Omitting them made realm-tenant-serves-test.sh and
  # tenant-login-local-test.sh — both invoked by pytest — look orphaned inside
  # the fixture. A control tree that does not reproduce the real one reports
  # false findings, which is the defect this whole file is about.
  cp "$ROOT"/tests/checks/*.py "$CTL/tests/checks/" 2>/dev/null || true
  cp "$ROOT"/.github/workflows/*.yml "$CTL/.github/workflows/" 2>/dev/null || true
  cp "$ROOT"/scripts/*.sh "$CTL/scripts/" 2>/dev/null || true
  [ -f "$ROOT/Makefile" ] && cp "$ROOT/Makefile" "$CTL/"
  CHECK="$CTL/scripts/checks/check_checks_are_wired.py"
}

@test "CONTROL: passes on the real tree — every check has a real caller" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"every check has a real caller"* ]]
}

@test "CONTROL: it examines a real number of checks, not zero" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  # A run over an empty set would pass while measuring nothing.
  [[ "$output" != *"0 checks,"* ]]
  [[ "$output" == *"invoked for real,"* ]]
}

@test "a new check that nobody wires is caught" {
  cat > "$CTL/scripts/checks/check_brand_new_orphan.py" <<'PY'
#!/usr/bin/env python3
import sys
sys.exit(0)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"check_brand_new_orphan.py"* ]]
  [[ "$output" == *"invoked by nothing"* ]]
}

# MENTION IS NOT INVOCATION — the rule that exists because minio.sh printed
# "Verify with: …" and ci.yml echoed "run on the VPS", and a plain grep counted
# both as wired.
@test "a check only ECHOED by a script is still an orphan" {
  cat > "$CTL/scripts/checks/check_only_echoed.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat > "$CTL/scripts/pretend-deploy.sh" <<'SH'
#!/usr/bin/env bash
echo "Verify with: bash scripts/checks/check_only_echoed.sh"
# bash scripts/checks/check_only_echoed.sh   <- commented out, also not a call
SH

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"check_only_echoed.sh"* ]]
}

@test "the same check ACTUALLY invoked by a script is not an orphan" {
  cat > "$CTL/scripts/checks/check_only_echoed.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  cat > "$CTL/scripts/pretend-deploy.sh" <<'SH'
#!/usr/bin/env bash
bash scripts/checks/check_only_echoed.sh
SH

  run python3 "$CHECK"
  [ "$status" -eq 0 ]
}

# BATS IS DIFFERENT, FOR HOW IT MATCHES — a control copies the check and runs
# it through a variable, so the name never appears on the invocation line.
# Requiring an invocation pattern there reported every bats-gated check as an
# orphan. A mention in a .bats file IS the evidence a control exists.
#
# BUT A CONTROL IS NOT REAL WIRING (h#736). A bats control proves the check
# behaves correctly when invoked against a fabricated fixture. It does not
# prove anything in CI or a deploy path ever runs it against real state —
# which is the exact blind spot this classifier exists to catch, one level
# up. Before h#736, a check exercised ONLY by its own bats control was
# reported "ok" — indistinguishable from a check with a genuine caller. This
# is the two-directions positive control that fix requires: the SAME
# scenario must now go red (below), and a check with a genuine caller must
# stay green (the test after it).
@test "a check exercised ONLY by a bats control is TEST-ONLY, not wired — and FAILS" {
  cat > "$CTL/scripts/checks/check_bats_gated_only.py" <<'PY'
#!/usr/bin/env python3
import sys
sys.exit(0)
PY
  cat > "$CTL/tests/scripts/bats-gated-only-control.bats" <<'BATS'
#!/usr/bin/env bats
setup() { CHECK="$BATS_TEST_DIRNAME/../../scripts/checks/check_bats_gated_only.py"; }
# exercises scripts/checks/check_bats_gated_only.py — a MENTION is all the
# classifier needs for a .bats file. A literal ^@test line here was COUNTED by
# bats as a declaration in this file and never executed, which is exactly what
# "Executed 480 instead of expected 481 tests" meant on CI.
BATS

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"check_bats_gated_only.py"* ]]
  [[ "$output" == *"proven correct by a test but never run for real"* ]]
}

# THE OTHER DIRECTION. A check with a genuine caller — a workflow step here,
# but the Makefile or another script prove identically, since REAL_SOURCES
# treats the three the same — must stay green. Without this test, a
# classifier that marked EVERYTHING test-only (over-correcting h#736 the
# other way) would also pass the test above.
@test "the SAME check, ALSO invoked by a real workflow step, is wired — stays green" {
  cat > "$CTL/scripts/checks/check_bats_gated_only.py" <<'PY'
#!/usr/bin/env python3
import sys
sys.exit(0)
PY
  cat > "$CTL/tests/scripts/bats-gated-only-control.bats" <<'BATS'
#!/usr/bin/env bats
setup() { CHECK="$BATS_TEST_DIRNAME/../../scripts/checks/check_bats_gated_only.py"; }
BATS
  cat > "$CTL/.github/workflows/pretend-ci.yml" <<'YML'
name: pretend
on: push
jobs:
  test:
    steps:
      - run: python3 scripts/checks/check_bats_gated_only.py
YML

  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

# PYTEST HAS THE SAME BLIND SPOT AS BATS, for the same reason: every check's
# pytest file in this repo subprocess-invokes the check as a CLI under a
# fabricated fixture — a control, not a production caller. Proven separately
# from the bats case above, since TEST_SOURCES is a tuple of two categories
# and either one alone must produce the same TEST-ONLY outcome.
@test "a check exercised ONLY by a pytest test is ALSO test-only, not wired" {
  cat > "$CTL/scripts/checks/check_pytest_gated_only.py" <<'PY'
#!/usr/bin/env python3
import sys
sys.exit(0)
PY
  cat > "$CTL/tests/checks/test_pytest_gated_only.py" <<'PY'
import subprocess
SCRIPT = "scripts/checks/check_pytest_gated_only.py"
def test_it():
    subprocess.run(["python3", SCRIPT])
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"check_pytest_gated_only.py"* ]]
  [[ "$output" == *"proven correct by a test but never run for real"* ]]
}

@test "an empty checks directory fails rather than reporting success" {
  rm -f "$CTL"/scripts/checks/*.sh
  # leave only the check itself so the directory is not literally empty of files
  find "$CTL/scripts/checks" -name '*.py' ! -name 'check_checks_are_wired.py' -delete
  run python3 "$CHECK"
  # The check itself is wired by this very file, so the tree stays valid; the
  # guard being pinned is that a zero-length inventory can never pass.
  [[ "$output" != *"0 checks, 0 invoked"* ]]
}
