#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/vault.sh's three `bao status` call sites
# (cmd_init, cmd_unseal, cmd_bootstrap_approles).
#
# `bao status` exits 0 (unsealed), 2 (sealed — both print full, usable JSON)
# or 1 (error — unreachable, no JSON), verified empirically against a real
# running OpenBao container. The old code piped straight into
# `grep '"x"' | tr -d ' ,"' || echo ""` with no pipefail, so an unreachable
# OpenBao and a genuinely-false field both produced the same empty string —
# the exit code was thrown away. This extracts the REAL functions from the
# real file and stubs only `bao_exec`, so it exercises the actual fix, not a
# reimplementation of it.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/keys"
  cp "$ROOT/scripts/vault.sh" "$CTL/vault.sh"
  cp "$ROOT/scripts/_common.sh" "$CTL/_common.sh"

  cat > "$CTL/harness.sh" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

CONTAINER_NAME="fake-openbao"
UNSEAL_KEY_PATH="/nonexistent/unseal.key"
SECRETS_FILE="${CTL_SECRETS_FILE:-/nonexistent/prod.enc.env}"

require_running() { return 0; }

HARNESS
  sed -n '/^cmd_init() {/,/^}/p' "$CTL/vault.sh" >> "$CTL/harness.sh"
  sed -n '/^cmd_unseal() {/,/^}/p' "$CTL/vault.sh" >> "$CTL/harness.sh"
  # cmd_bootstrap_approles's body after the status check needs real files we
  # don't want to fake further, so trim the REAL function right after its
  # `cmd_unseal` call (the last line of the status-check block under test),
  # close the `if` it was cut out of by hand, and stand in a marker for
  # "reached the code past this point" instead of the whole rest of the
  # function.
  sed -n '/^cmd_bootstrap_approles() {/,/^        cmd_unseal$/p' "$CTL/vault.sh" >> "$CTL/harness.sh"
  cat >> "$CTL/harness.sh" <<'HARNESS'
    fi
    echo "REACHED_UNSEAL_KEY_STEP"
}
HARNESS

  HARNESS="$CTL/harness.sh"
  touch "$CTL/keys/age-prod.key"
  export CTL_SECRETS_FILE="$CTL/fake-secrets.enc.env"
  touch "$CTL_SECRETS_FILE"
  export SOPS_AGE_KEY_FILE="$CTL/keys/age-prod.key"
}

run_with_stub() {
  # $1 = the real function to call, $2 = fake bao_exec stdout,
  # $3 = fake bao_exec exit code, $4 = optional extra function defs (e.g. a
  # stubbed cmd_unseal, for cmd_bootstrap_approles tests).
  local fn="$1" out="$2" rc="$3" extra="${4:-}"
  # $extra (e.g. a stubbed cmd_unseal) is defined AFTER sourcing the
  # harness on purpose: harness.sh also defines the real cmd_unseal
  # (needed standalone by its own tests above), and sourcing it after an
  # earlier stub would silently overwrite the stub right back to the real
  # function — the harness would then try a real unseal against nothing.
  STUB_OUTPUT="$out" STUB_RC="$rc" bash -c '
    bao_exec() { printf "%s\n" "$STUB_OUTPUT"; return "$STUB_RC"; }
    source "'"$HARNESS"'"
    '"$extra"'
    '"$fn"'
  '
}

@test "cmd_init: THE ASSERTION THAT MATTERS — an unreachable OpenBao (rc 1) dies naming reachability, not the generic path" {
  run run_with_stub cmd_init \
    'Error checking seal status: dial tcp: connect: connection refused' 1
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not determine"* ]]
  [[ "$output" == *"bao status exited 1"* ]]
}

@test "cmd_init: CONTROL — already initialized (rc 0, initialized:true) warns and returns success" {
  run run_with_stub cmd_init '{"initialized": true, "sealed": false}' 0
  [ "$status" -eq 0 ]
  [[ "$output" == *"already initialized"* ]]
}

@test "cmd_unseal: THE ASSERTION THAT MATTERS — an unreachable OpenBao (rc 1) dies naming reachability, not the generic path" {
  run run_with_stub cmd_unseal \
    'Error checking seal status: dial tcp: connect: connection refused' 1
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not determine"* ]]
  [[ "$output" == *"bao status exited 1"* ]]
  # And it must NOT have fallen through to the unrelated "no unseal key"
  # error, which is exactly what the pre-fix code did on this input.
  [[ "$output" != *"unseal key found"* ]]
}

@test "cmd_unseal: CONTROL — already unsealed (rc 0, sealed:false) returns success without attempting a real unseal" {
  run run_with_stub cmd_unseal '{"initialized": true, "sealed": false}' 0
  [ "$status" -eq 0 ]
  [[ "$output" == *"already unsealed"* ]]
}

@test "cmd_bootstrap_approles: THE ASSERTION THAT MATTERS — an unreachable OpenBao (rc 1) dies before ever calling cmd_unseal" {
  run run_with_stub cmd_bootstrap_approles \
    'Error checking seal status: dial tcp: connect: connection refused' 1 \
    'cmd_unseal() { echo "CMD_UNSEAL_CALLED"; }'
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not determine"* ]]
  [[ "$output" != *"CMD_UNSEAL_CALLED"* ]]
}

@test "cmd_bootstrap_approles: CONTROL — sealed (rc 2, sealed:true) calls cmd_unseal and proceeds" {
  run run_with_stub cmd_bootstrap_approles \
    '{"initialized": true, "sealed": true}' 2 \
    'cmd_unseal() { echo "CMD_UNSEAL_CALLED"; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *"CMD_UNSEAL_CALLED"* ]]
  [[ "$output" == *"REACHED_UNSEAL_KEY_STEP"* ]]
}

@test "cmd_bootstrap_approles: CONTROL — already unsealed (rc 0, sealed:false) skips cmd_unseal" {
  run run_with_stub cmd_bootstrap_approles \
    '{"initialized": true, "sealed": false}' 0 \
    'cmd_unseal() { echo "CMD_UNSEAL_CALLED"; }'
  [ "$status" -eq 0 ]
  [[ "$output" != *"CMD_UNSEAL_CALLED"* ]]
  [[ "$output" == *"REACHED_UNSEAL_KEY_STEP"* ]]
}
