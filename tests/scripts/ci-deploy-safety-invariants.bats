#!/usr/bin/env bats
#
# POSITIVE CONTROL for the "Assert deploy safety invariants" step in
# .github/workflows/ci.yml.
#
# Two defects, found together (h#732). The one that was FILED: the second
# check's `grep "docker compose" scripts/deploy.sh | ... | grep -v -- "-p "`
# is the 0==0 trap — if deploy.sh's invocation style is ever renamed, the
# first grep matches zero lines and the pipeline reports "nothing to
# complain about" without having examined a single real invocation.
#
# The one FOUND WHILE FIXING IT, more severe: GitHub Actions runs `run:`
# blocks under `bash -eo pipefail`, and bash's `set -e` explicitly EXEMPTS a
# `!`-negated command from triggering abort, even when the negated result is
# failure. `! (pipeline)` in the ORIGINAL step never aborted on a real
# violation — it fell through to the next line, and the step always ended
# on the final `echo`'s exit 0. Verified directly against real deploy.sh
# mutations under the exact bash flags GitHub Actions uses, not by reasoning
# about bash semantics alone.
#
# This extracts the step's exact `run:` body from the real workflow YAML —
# so a future edit to the step is re-tested against these fixtures rather
# than re-verified by hand — and runs it against fixture copies of
# deploy.sh, under the same `bash -eo pipefail` GitHub Actions uses.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    WORKFLOW="$ROOT/.github/workflows/ci.yml"
    SCRIPT="$BATS_TEST_TMPDIR/step.sh"

    python3 - "$WORKFLOW" "$SCRIPT" <<'PY'
import sys, yaml
workflow_path, out_path = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(workflow_path))
run_body = None
for s in d["jobs"]["test"]["steps"]:
    if s.get("name") == "Assert deploy safety invariants":
        run_body = s["run"]
        break
assert run_body, "could not find the 'Assert deploy safety invariants' step — did its name change?"
open(out_path, "w").write(run_body)
PY

    FIXTURE="$BATS_TEST_TMPDIR/fixture"
    mkdir -p "$FIXTURE/scripts"
}

run_step() {
    (cd "$FIXTURE" && bash -eo pipefail "$SCRIPT")
}

@test "extraction sanity: the step body was found and is non-trivial" {
    [ -s "$SCRIPT" ]
    grep -q "remove-orphans" "$SCRIPT"
}

@test "CONTROL: a clean deploy.sh (no violations, real invocations present) passes" {
    cp "$ROOT/scripts/deploy.sh" "$FIXTURE/scripts/deploy.sh"
    run run_step
    [ "$status" -eq 0 ]
    [[ "$output" == *"All safety checks passed."* ]]
}

@test "THE ASSERTION THAT MATTERS: a real --remove-orphans violation fails the step" {
    cp "$ROOT/scripts/deploy.sh" "$FIXTURE/scripts/deploy.sh"
    echo '  docker compose down --remove-orphans' >> "$FIXTURE/scripts/deploy.sh"
    run run_step
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"* ]]
    [[ "$output" != *"All safety checks passed."* ]]
}

@test "THE ASSERTION THAT MATTERS: a real docker-compose-missing--p violation fails the step" {
    cp "$ROOT/scripts/deploy.sh" "$FIXTURE/scripts/deploy.sh"
    echo '  docker compose -f "$f" up -d' >> "$FIXTURE/scripts/deploy.sh"
    run run_step
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"* ]]
    [[ "$output" == *"missing -p"* ]]
    [[ "$output" != *"All safety checks passed."* ]]
}

@test "THE ASSERTION THAT MATTERS: zero docker-compose invocations refuses rather than passing" {
    printf '#!/bin/bash\necho "totally different tool now"\n' > "$FIXTURE/scripts/deploy.sh"
    run run_step
    [ "$status" -eq 1 ]
    [[ "$output" == *"CANNOT DETERMINE"* ]]
    [[ "$output" != *"All safety checks passed."* ]]
}

@test "CONTROL: the OLD (!)-negated logic could not fail on the same real violations (regression guard)" {
    # Not a test of the new step — a permanent record that the bug was
    # real. If this ever starts failing, the old shape has been
    # reintroduced elsewhere and this comment is the only thing that will
    # say why it matters.
    OLD_SCRIPT="$BATS_TEST_TMPDIR/old_step.sh"
    cat > "$OLD_SCRIPT" <<'OLD'
echo "Checking: no --remove-orphans..."
! (grep -- "--remove-orphans" scripts/deploy.sh | grep -v "^#" | grep -v "^[[:space:]]*#")

echo "Checking: all docker compose calls use -p..."
! (grep "docker compose" scripts/deploy.sh | grep -v "^#" | grep -v "^[[:space:]]*#" | grep -v -- "-p ")

echo "All safety checks passed."
OLD

    cp "$ROOT/scripts/deploy.sh" "$FIXTURE/scripts/deploy.sh"
    echo '  docker compose down --remove-orphans' >> "$FIXTURE/scripts/deploy.sh"

    run bash -c "cd '$FIXTURE' && bash -eo pipefail '$OLD_SCRIPT'"
    [ "$status" -eq 0 ]
    [[ "$output" == *"All safety checks passed."* ]]
}

@test "exit codes for clean / violation / cannot-determine are correctly distinguishable by message" {
    cp "$ROOT/scripts/deploy.sh" "$FIXTURE/scripts/deploy.sh"
    run run_step
    clean_status="$status"
    clean_output="$output"

    VIOLATION_FIXTURE="$BATS_TEST_TMPDIR/fixture-violation"
    mkdir -p "$VIOLATION_FIXTURE/scripts"
    cp "$ROOT/scripts/deploy.sh" "$VIOLATION_FIXTURE/scripts/deploy.sh"
    echo '  docker compose down --remove-orphans' >> "$VIOLATION_FIXTURE/scripts/deploy.sh"
    FIXTURE="$VIOLATION_FIXTURE" run run_step
    violation_status="$status"

    EMPTY_FIXTURE="$BATS_TEST_TMPDIR/fixture-empty"
    mkdir -p "$EMPTY_FIXTURE/scripts"
    printf '#!/bin/bash\necho "nothing here"\n' > "$EMPTY_FIXTURE/scripts/deploy.sh"
    FIXTURE="$EMPTY_FIXTURE" run run_step
    empty_output="$output"

    [ "$clean_status" -eq 0 ]
    [ "$violation_status" -eq 1 ]
    [[ "$clean_output" == *"passed"* ]]
    [[ "$empty_output" == *"CANNOT DETERMINE"* ]]
}
