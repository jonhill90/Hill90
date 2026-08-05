#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/minio.sh's secret_for().
#
# A sops decrypt failure (bad/missing age key, corrupted store) and a
# genuinely-absent key used to print the IDENTICAL "not set and was not
# found" message, sending an operator debugging the wrong file instead of
# their age key. Each test here extracts the REAL secret_for() out of the
# real file with sed, so this tests the actual fix rather than a
# reimplementation of it.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL"
  touch "$CTL/fake_secrets.enc.env" "$CTL/fake-age.key"

  # The harness every test sources: real _common.sh (for die/require_file/
  # ensure_age_key), the real secret_for() extracted from minio.sh, and a
  # fake `sops` the test itself defines afterward.
  cat > "$CTL/harness.sh" <<HARNESS
set -e
PROJECT_ROOT="$CTL"
SECRETS_FILE="$CTL/fake_secrets.enc.env"
export SOPS_AGE_KEY_FILE="$CTL/fake-age.key"
source "$ROOT/scripts/_common.sh"
eval "\$(sed -n '/^secret_for() {/,/^}/p' "$ROOT/scripts/minio.sh")"
HARNESS
}

@test "CONTROL: resolves a real key from a successful decrypt" {
  cat >> "$CTL/harness.sh" <<'EOF'
sops() { printf 'MINIO_ROOT_USER=realvalue123\nOTHER=x\n'; }
MINIO_ROOT_USER="" secret_for MINIO_ROOT_USER
EOF
  run bash "$CTL/harness.sh"
  [ "$status" -eq 0 ]
  [ "$output" = "realvalue123" ]
}

# THE ASSERTION THAT MATTERS: a decrypt failure must be distinguishable from
# a genuinely-absent key, not collapse into the same message.
@test "THE ASSERTION THAT MATTERS: a sops decrypt failure names the file and failure mode, not the generic not-found message" {
  cat >> "$CTL/harness.sh" <<'EOF'
sops() { return 1; }
MINIO_ROOT_USER="" secret_for MINIO_ROOT_USER
EOF
  run bash "$CTL/harness.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"could not decrypt"* ]]
  [[ "$output" == *"fake_secrets.enc.env"* ]]
  [[ "$output" == *"age key"* ]]
  [[ "$output" != *"is not set and was not found"* ]]
}

@test "CONTROL: a genuinely-absent key (decrypt succeeds) still gets the not-found message" {
  cat >> "$CTL/harness.sh" <<'EOF'
sops() { printf 'SOME_OTHER_KEY=x\n'; }
MINIO_ROOT_USER="" secret_for MINIO_ROOT_USER
EOF
  run bash "$CTL/harness.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"is not set and was not found"* ]]
  [[ "$output" != *"could not decrypt"* ]]
}

@test "CONTROL: the two failure messages are distinct, not the same string" {
  cat > "$CTL/harness_fail.sh" <<EOF
$(cat "$CTL/harness.sh")
sops() { return 1; }
MINIO_ROOT_USER="" secret_for MINIO_ROOT_USER
EOF
  cat > "$CTL/harness_absent.sh" <<EOF
$(cat "$CTL/harness.sh")
sops() { printf 'SOME_OTHER_KEY=x\n'; }
MINIO_ROOT_USER="" secret_for MINIO_ROOT_USER
EOF
  run bash "$CTL/harness_fail.sh"
  local fail_output="$output"
  run bash "$CTL/harness_absent.sh"
  local absent_output="$output"
  [ "$fail_output" != "$absent_output" ]
}

@test "no decrypted content is ever printed on a decrypt failure" {
  cat >> "$CTL/harness.sh" <<'EOF'
sops() { echo "THIS-WOULD-BE-A-LEAKED-SECRET" >&2; return 1; }
MINIO_ROOT_USER="" secret_for MINIO_ROOT_USER
EOF
  run bash "$CTL/harness.sh"
  [ "$status" -eq 1 ]
  # The fake sops writes to its OWN stderr as a stand-in for what real sops
  # might emit on failure — secret_for's fix redirects sops's stderr to
  # /dev/null (2>/dev/null), so this must never reach the caller's output.
  [[ "$output" != *"THIS-WOULD-BE-A-LEAKED-SECRET"* ]]
}
