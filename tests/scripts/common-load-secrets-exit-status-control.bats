#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/_common.sh's load_secrets().
#
# `sops -d "$secrets_file" | grep ... | while read ...; done > "$temp_file"`
# had no pipefail (this file sets neither `set -e` nor `pipefail` — it's a
# sourced library, safety is the caller's choice), so the pipeline's exit
# status came from the `while` loop, which exits 0 on empty input. A failed
# `sops -d` therefore gave an empty temp_file, a successful `source`, and a
# clean return — the widest-reaching instance of this shape in the repo,
# since load_secrets is the primary secret-loading entrypoint and
# `decrypted` holds the entire store, not one value.
#
# This forces a REAL sops decrypt failure — a genuine age key that does not
# match the file's recipient, not a mocked sops binary — the same standard
# used for #783's minio.sh control.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL"
  cp "$ROOT/scripts/_common.sh" "$CTL/_common.sh"

  age-keygen -o "$CTL/real.key" 2>"$CTL/real.pub.txt"
  REAL_PUB="$(grep -oE 'age1[a-z0-9]+' "$CTL/real.pub.txt")"
  age-keygen -o "$CTL/bogus.key" 2>/dev/null

  cat > "$CTL/plain.env" <<'PLAIN'
FOO_SECRET=hunter2
BAR_TOKEN=abc123
PLAIN
  sops --age "$REAL_PUB" -e "$CTL/plain.env" > "$CTL/secrets.enc.env"
}

run_load_secrets() {
  local key_file="$1"
  SOPS_AGE_KEY_FILE="$key_file" CTL_SECRETS_FILE="$CTL/secrets.enc.env" bash -c '
    source "'"$CTL"'/_common.sh"
    load_secrets "$CTL_SECRETS_FILE"
    echo "REACHED_AFTER_LOAD_SECRETS"
    echo "FOO_SECRET=${FOO_SECRET:-<unset>}"
  '
}

@test "THE ASSERTION THAT MATTERS: a real sops decrypt failure returns non-zero, not success" {
  run run_load_secrets "$CTL/bogus.key"
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not decrypt"* ]]
  # The old defect's whole shape: does it stop here, or plow on and act as
  # if the secrets loaded?
  [[ "$output" != *"REACHED_AFTER_LOAD_SECRETS"* ]]
}

@test "THE ASSERTION THAT MATTERS: a decrypt failure exports nothing, not an empty environment silently accepted" {
  run run_load_secrets "$CTL/bogus.key"
  [[ "$output" != *"FOO_SECRET=hunter2"* ]]
}

@test "CONTROL: a successful decrypt exports the secrets and returns success" {
  run run_load_secrets "$CTL/real.key"
  [ "$status" -eq 0 ]
  [[ "$output" == *"REACHED_AFTER_LOAD_SECRETS"* ]]
  [[ "$output" == *"FOO_SECRET=hunter2"* ]]
}

@test "no decrypted secret content is ever printed on a decrypt failure" {
  run run_load_secrets "$CTL/bogus.key"
  [[ "$output" != *"hunter2"* ]]
  [[ "$output" != *"abc123"* ]]
}
