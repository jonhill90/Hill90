#!/usr/bin/env bats
#
# POSITIVE CONTROL for scripts/checks/check_destructive_commands.sh.
#
# Filed as part of the deliberate sweep after #724 (the Grafana SSO check
# raced its own container). This script had a sibling defect of the OTHER
# shape from that sweep: `for f in scripts/*.sh .github/workflows/*.yml` with
# neither glob matching leaves the pattern unexpanded, `[ -f "$f" ]` false,
# every iteration `continue`s, FAIL never leaves 0 — a clean "No destructive
# volume commands found" having scanned nothing. The exact 0==0 trap
# check_alert_counts_documented.py already refuses (two independently-empty
# derivations are not agreement), this script had no equivalent guard for.
#
# Reproduced directly before the fix: `cd /tmp/empty && bash
# check_destructive_commands.sh` exited 0 with that message. Latent, not
# live, because the only caller (ci.yml's "Assert no destructive volume
# commands" step) runs via actions/checkout@v4 with no working-directory
# override — one workflow edit away.

CHECK=""

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_destructive_commands.sh"
}

# ------------------------------------------------------------ CANNOT TELL ---
# This is the fix. A check that scanned zero files must not report clean.

@test "CANNOT DETERMINE: run from a directory with no scripts/ or .github/workflows/ exits 2, not 0" {
    EMPTY="$BATS_TEST_TMPDIR/empty"
    mkdir -p "$EMPTY"
    cd "$EMPTY"
    run bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CANNOT DETERMINE"* ]]
    [[ "$output" != *"No destructive volume commands found"* ]]
}

# ------------------------------------------------------------------ CLEAN ---

@test "CONTROL: run from a real repo root with real files and no violations exits 0" {
    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO/scripts" "$REPO/.github/workflows"
    echo 'echo hello' > "$REPO/scripts/harmless.sh"
    echo 'name: harmless' > "$REPO/.github/workflows/harmless.yml"
    cp "$CHECK" "$REPO/checker.sh"
    cd "$REPO"
    run bash checker.sh
    [ "$status" -eq 0 ]
    [[ "$output" == *"No destructive volume commands found"* ]]
    [[ "$output" == *"2 files scanned"* ]]
}

# ------------------------------------------------------------------- RED ----
# Detection itself must still work — the fix must not have blunted it.

@test "CONTROL: a real docker compose down -v violation is still caught" {
    REPO="$BATS_TEST_TMPDIR/repo-bad"
    mkdir -p "$REPO/scripts" "$REPO/.github/workflows"
    echo 'docker compose -f x.yml down -v' > "$REPO/scripts/bad.sh"
    cp "$CHECK" "$REPO/checker.sh"
    cd "$REPO"
    run bash checker.sh
    [ "$status" -eq 1 ]
    [[ "$output" == *"FAIL"* ]]
    [[ "$output" == *"volume removal"* ]]
}

@test "CONTROL: docker volume rm is still caught" {
    REPO="$BATS_TEST_TMPDIR/repo-volrm"
    mkdir -p "$REPO/scripts" "$REPO/.github/workflows"
    echo 'docker volume rm hill90-data' > "$REPO/scripts/bad.sh"
    cp "$CHECK" "$REPO/checker.sh"
    cd "$REPO"
    run bash checker.sh
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker volume rm"* ]]
}

@test "CONTROL: docker system prune is still caught" {
    REPO="$BATS_TEST_TMPDIR/repo-prune"
    mkdir -p "$REPO/scripts" "$REPO/.github/workflows"
    echo 'docker system prune -f' > "$REPO/scripts/bad.sh"
    cp "$CHECK" "$REPO/checker.sh"
    cd "$REPO"
    run bash checker.sh
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker system prune"* ]]
}

@test "CONTROL: scripts/local.sh remains exempt from the volume rule" {
    REPO="$BATS_TEST_TMPDIR/repo-exempt"
    mkdir -p "$REPO/scripts" "$REPO/.github/workflows"
    echo 'docker compose -f x.yml down -v' > "$REPO/scripts/local.sh"
    cp "$CHECK" "$REPO/checker.sh"
    cd "$REPO"
    run bash checker.sh
    [ "$status" -eq 0 ]
}

@test "CONTROL: exit codes for empty-scan vs clean vs violation are genuinely different states" {
    EMPTY="$BATS_TEST_TMPDIR/empty2"
    mkdir -p "$EMPTY"
    cd "$EMPTY"
    run bash "$CHECK"
    empty_status="$status"

    CLEAN="$BATS_TEST_TMPDIR/clean2"
    mkdir -p "$CLEAN/scripts" "$CLEAN/.github/workflows"
    echo 'echo hi' > "$CLEAN/scripts/x.sh"
    cp "$CHECK" "$CLEAN/checker.sh"
    cd "$CLEAN"
    run bash checker.sh
    clean_status="$status"

    BAD="$BATS_TEST_TMPDIR/bad2"
    mkdir -p "$BAD/scripts" "$BAD/.github/workflows"
    echo 'docker volume rm x' > "$BAD/scripts/x.sh"
    cp "$CHECK" "$BAD/checker.sh"
    cd "$BAD"
    run bash checker.sh
    bad_status="$status"

    [ "$empty_status" -ne "$clean_status" ]
    [ "$empty_status" -ne "$bad_status" ]
    [ "$clean_status" -ne "$bad_status" ]
}
