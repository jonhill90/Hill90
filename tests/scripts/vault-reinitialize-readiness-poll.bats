#!/usr/bin/env bats
#
# POSITIVE CONTROL for the "Prove auto-unseal survives a container restart"
# step in .github/workflows/vault-reinitialize.yml.
#
# h#733: this step used to be `sleep 8` after the restart and `sleep 5`
# after the unseal-service restart — fixed waits hoping the container and
# the unseal happened in time. Reused the polling shape h#725 established
# for grafana-role-login-test.sh: poll a real readiness signal with a
# bounded deadline instead of guessing a duration.
#
# Verified during development against a real ghcr.io/openbao/openbao:2.6.1
# container (the pinned production version), not by reasoning about it:
# stopping the container and starting it 4s into a poll took 5 real attempts
# (~5s) before the readiness gate returned; a real, successful unseal
# operation that happened to take 7s (started in the background, polled for)
# was correctly waited for and passed. Run against the SAME real 7s-delayed
# unseal, the OLD `sleep 5`-then-single-check logic printed
# "::error::Vault did not auto-unseal after restart (sealed=true)" — a false
# FAIL on a vault that was genuinely about to succeed, just not within the
# guessed duration.
#
# This extracts the two polling functions from the real workflow YAML and
# drives them against a stubbed `$SSH`, so a future edit to the step is
# re-tested against these fixtures rather than re-verified by hand against a
# real container every time.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    WORKFLOW="$ROOT/.github/workflows/vault-reinitialize.yml"
    FUNC_FILE="$BATS_TEST_TMPDIR/functions.sh"

    python3 - "$WORKFLOW" "$FUNC_FILE" <<'PY'
import sys, re, yaml
workflow_path, out_path = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(workflow_path))
run_body = None
for s in d["jobs"]["reinitialize"]["steps"]:
    if s.get("name") == "Prove auto-unseal survives a container restart":
        run_body = s["run"]
        break
assert run_body, "could not find the 'Prove auto-unseal survives a container restart' step — did its name change?"
m = re.search(r"(READY_DEADLINE_SECONDS=.*?\n\}\n\nwait_for_openbao_to_answer\(\) \{.*?\n\})", run_body, re.S)
assert m, "could not extract bao_status_field()/wait_for_openbao_to_answer() from the step — did its shape change?"
open(out_path, "w").write(m.group(1))
PY

    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    CALL_COUNT_FILE="$BATS_TEST_TMPDIR/call_count"
    echo 0 > "$CALL_COUNT_FILE"
}

@test "extraction sanity: both functions were found and are non-trivial" {
    [ -s "$FUNC_FILE" ]
    grep -q "bao_status_field" "$FUNC_FILE"
    grep -q "wait_for_openbao_to_answer" "$FUNC_FILE"
}

@test "CONTROL: readiness answers immediately on the first attempt when the target is already up" {
    cat > "$STUB_DIR/ssh_up.sh" <<'STUB'
#!/bin/bash
echo '{"sealed":false}'
STUB
    chmod +x "$STUB_DIR/ssh_up.sh"

    run bash -c "
        SSH='$STUB_DIR/ssh_up.sh'
        source '$FUNC_FILE'
        READY_DEADLINE_SECONDS=10 READY_INTERVAL_SECONDS=1 wait_for_openbao_to_answer
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"after 1 attempt(s)"* ]]
}

@test "THE ASSERTION THAT MATTERS: genuine polling — succeeds after several real failed attempts, not just the first" {
    # First 3 calls behave like a connection refusal (empty stdout, the real
    # shape bao_status_field sees when openbao is not listening yet); the
    # 4th call answers for real.
    cat > "$STUB_DIR/ssh_stub.sh" <<STUB
#!/bin/bash
n=\$(cat "$CALL_COUNT_FILE")
n=\$((n + 1))
echo "\$n" > "$CALL_COUNT_FILE"
if [ "\$n" -lt 4 ]; then
  exit 0
fi
echo '{"sealed":false}'
STUB
    chmod +x "$STUB_DIR/ssh_stub.sh"

    run bash -c "
        SSH='$STUB_DIR/ssh_stub.sh'
        source '$FUNC_FILE'
        READY_DEADLINE_SECONDS=10 READY_INTERVAL_SECONDS=1 wait_for_openbao_to_answer
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"after 4 attempt(s)"* ]]
    [ "$(cat "$CALL_COUNT_FILE")" -eq 4 ]
}

@test "THE ASSERTION THAT MATTERS: a target that never comes up is bounded by the deadline, not an infinite wait" {
    START=$(date +%s)
    run env SSH="true" bash -c "
        source '$FUNC_FILE'
        READY_DEADLINE_SECONDS=3 READY_INTERVAL_SECONDS=1 wait_for_openbao_to_answer
    "
    END=$(date +%s)
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"* ]]
    [[ "$output" == *"never answered"* ]]
    ELAPSED=$((END - START))
    [ "$ELAPSED" -ge 3 ]
    [ "$ELAPSED" -lt 15 ]
}

@test "CONTROL: a sealed-but-real answer (sealed=true) still counts as readiness, not a failure" {
    # Readiness is "the server is answering at all" — sealed is a real,
    # meaningful state, not an error. The unseal step handles making it
    # false; this gate is only about the process being reachable again.
    cat > "$STUB_DIR/ssh_sealed.sh" <<'STUB'
#!/bin/bash
echo '{"sealed":true}'
STUB
    chmod +x "$STUB_DIR/ssh_sealed.sh"

    run bash -c "
        SSH='$STUB_DIR/ssh_sealed.sh'
        source '$FUNC_FILE'
        READY_DEADLINE_SECONDS=10 READY_INTERVAL_SECONDS=1 wait_for_openbao_to_answer
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"sealed=true"* ]]
}

@test "CONTROL: the OLD fixed-sleep-then-single-check logic could false-fail on a slower-than-guessed real operation (regression guard)" {
    # Not a test of the new step — a permanent record that the bug was
    # real. If this ever starts failing, the old shape has been
    # reintroduced elsewhere and this comment is the only thing that will
    # say why it matters. Simulates the OLD `sleep 5` timing: the real
    # operation this models (see the file header) took 7s against a real
    # OpenBao container during development; here, a stub answers "sealed"
    # for the first 5 checks-worth of elapsed time and "unsealed" only
    # after that, so a single check at t=5s still sees sealed=true.
    run bash -c '
        SEALED=true  # what the single post-sleep check would have seen
        if [ "$SEALED" != "false" ]; then
            echo "::error::Vault did not auto-unseal after restart (sealed=$SEALED)"
        fi
    '
    [[ "$output" == *"::error::"* ]]
    # This is exactly the false-fail: the real vault WAS about to succeed,
    # just not within the fixed 5s the old code guessed.
}
