#!/usr/bin/env bats
#
# POSITIVE CONTROL for scripts/checks/vault-sops-name-parity.sh.
#
# h#731: vault_keys() used to discard `docker exec`'s stderr entirely
# (`2>/dev/null`), so a docker-exec failure or a connection refusal (the
# "openbao mid-restart" scenario this issue names) produced empty stdout —
# indistinguishable from a genuinely absent KV v2 path, which ALSO produces
# empty stdout on that code path. Both printed the same "ABSENT" line.
#
# Verified directly against a real ghcr.io/openbao/openbao:2.6.1 container
# (the pinned production version) during development: a genuinely-absent
# path and a real connection refusal BOTH return exit code 2 from `bao`
# itself — only the stderr TEXT differs ("No value found at ..." vs
# "dial tcp ... connection refused"). With the container simply stopped, the
# OLD code reported a real, seeded, GENUINELY PRESENT path as "ABSENT". That
# is the decisive before/after this file's tests are the permanent form of —
# fast, CI-safe, no Docker/network dependency at test time, via a
# PATH-shadowing `docker` stub.

setup() {
    ROOT="$BATS_TEST_DIRNAME/../.."
    SCRIPT="$ROOT/scripts/checks/vault-sops-name-parity.sh"

    # vault_keys() is the whole surface of the bug — extract and source it
    # alone rather than running the full script, which needs a real SOPS
    # store this task must not touch.
    FUNC_FILE="$BATS_TEST_TMPDIR/vault_keys.sh"
    sed -n '/^VAULT_KEYS_ERR=/,/^}/p' "$SCRIPT" > "$FUNC_FILE"
    [ -s "$FUNC_FILE" ]

    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    export CONTAINER=fake-openbao
    export BAO_TOKEN=fake-token
}

stub_docker_exec() {
    # $1: scenario — present | absent | connection-refused | exec-fails.
    # One stub file is written per test, with the scenario baked in
    # directly, rather than dispatching on the real invocation's argv (which
    # is `docker exec -e ... -e ... "$CONTAINER" bao read ...` regardless of
    # scenario, so there is nothing scenario-specific to dispatch on).
    local scenario="$1"
    case "$scenario" in
        present)
            cat > "$STUB_DIR/docker" <<'STUB'
#!/bin/bash
echo '{"data":{"data":{"DB_NAME":"x","DB_USER":"y"}}}'
exit 0
STUB
            ;;
        absent)
            cat > "$STUB_DIR/docker" <<'STUB'
#!/bin/bash
echo "No value found at secret/data/does-not-exist" >&2
exit 2
STUB
            ;;
        connection-refused)
            cat > "$STUB_DIR/docker" <<'STUB'
#!/bin/bash
echo 'Error reading secret/data/x: Get "http://127.0.0.1:8200/v1/secret/data/x": dial tcp 127.0.0.1:8200: connect: connection refused' >&2
exit 2
STUB
            ;;
        exec-fails)
            cat > "$STUB_DIR/docker" <<'STUB'
#!/bin/bash
echo "Error response from daemon: container fake-openbao is not running" >&2
exit 1
STUB
            ;;
    esac
    chmod +x "$STUB_DIR/docker"
}

run_vault_keys() {
    env PATH="$STUB_DIR:$PATH" bash -c "
        set -uo pipefail
        source '$FUNC_FILE'
        keys=\"\$(vault_keys secret/whatever)\"
        rc=\$?
        echo \"RC=\$rc\"
        echo \"KEYS=\$keys\"
        echo \"ERR=\$(cat \"\$VAULT_KEYS_ERR\")\"
    "
}

@test "CONTROL: a genuinely present path returns success and the real keys" {
    stub_docker_exec present
    run run_vault_keys
    [[ "$output" == *"RC=0"* ]]
    [[ "$output" == *"DB_NAME"* ]]
}

@test "CONTROL: a genuinely absent path returns rc=1, not rc=2" {
    stub_docker_exec absent
    run run_vault_keys
    [[ "$output" == *"RC=1"* ]]
}

@test "THE ASSERTION THAT MATTERS: a connection refusal returns rc=2 (CANNOT DETERMINE), never rc=1 (ABSENT)" {
    stub_docker_exec connection-refused
    run run_vault_keys
    [[ "$output" == *"RC=2"* ]]
    [[ "$output" != *"RC=1"* ]]
    [[ "$output" == *"connection refused"* ]]
}

@test "THE ASSERTION THAT MATTERS: docker exec failing outright returns rc=2 (CANNOT DETERMINE), never rc=1 (ABSENT)" {
    stub_docker_exec exec-fails
    run run_vault_keys
    [[ "$output" == *"RC=2"* ]]
    [[ "$output" != *"RC=1"* ]]
    [[ "$output" == *"is not running"* ]]
}

@test "exit codes for present / absent / cannot-determine are three genuinely distinct outcomes" {
    stub_docker_exec present
    run run_vault_keys
    present_rc="$(printf '%s' "$output" | grep -o 'RC=[0-9]*' | head -1)"

    stub_docker_exec absent
    run run_vault_keys
    absent_rc="$(printf '%s' "$output" | grep -o 'RC=[0-9]*' | head -1)"

    stub_docker_exec connection-refused
    run run_vault_keys
    undetermined_rc="$(printf '%s' "$output" | grep -o 'RC=[0-9]*' | head -1)"

    [ "$present_rc" = "RC=0" ]
    [ "$absent_rc" = "RC=1" ]
    [ "$undetermined_rc" = "RC=2" ]
}

@test "CONTROL: the OLD (2>/dev/null, no classification) shape could not distinguish these (regression guard)" {
    # Not a test of the new function — a permanent record that the bug was
    # real. If this ever starts failing, the old shape has been
    # reintroduced elsewhere and this comment is the only thing that will
    # say why it matters.
    OLD_FUNC="$BATS_TEST_TMPDIR/vault_keys_old.sh"
    cat > "$OLD_FUNC" <<'OLD'
vault_keys_old() {
    BAO_TOKEN="$BAO_TOKEN" docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN \
        "$CONTAINER" bao read -format=json "secret/data/${1#secret/}" 2>/dev/null \
      | python3 -c 'import sys,json
try:
    print("\n".join(sorted(json.load(sys.stdin)["data"]["data"])))
except Exception:
    pass'
}
OLD
    stub_docker_exec exec-fails
    run env PATH="$STUB_DIR:$PATH" bash -c "source '$OLD_FUNC'; vault_keys_old secret/whatever"
    [ -z "$output" ]
    # Empty output here is EXACTLY what the caller in the old script read as
    # "ABSENT" — indistinguishable from a genuinely missing path, and from
    # a genuinely PRESENT one the docker-exec failure merely hid.
}
