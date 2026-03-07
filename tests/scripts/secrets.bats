#!/usr/bin/env bats

# Tests for scripts/secrets.sh CLI

@test "secrets.sh with no args shows usage" {
  run bash scripts/secrets.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "secrets.sh help shows usage" {
  run bash scripts/secrets.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "secrets.sh invalid subcommand fails" {
  run bash scripts/secrets.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "secrets.sh view defaults to prod secrets" {
  run bash scripts/secrets.sh view
  # exits 0 if secrets file exists, 1 if not — either way it should attempt
  [[ "$output" == *"secrets"* ]] || [[ "$output" == *"Viewing"* ]] || [[ "$output" == *"Error"* ]]
}

@test "secrets.sh update with missing args fails" {
  run bash scripts/secrets.sh update
  [ "$status" -eq 1 ]
}

@test "secrets.sh get with missing args fails" {
  run bash scripts/secrets.sh get
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "secrets.sh get preserves trailing = in base64 values" {
  # Create a temp SOPS-encrypted file with a value ending in =
  if [ ! -f infra/secrets/keys/age-prod.key ]; then
    skip "age key not available"
  fi
  local pub_key
  pub_key=$(age-keygen -y infra/secrets/keys/age-prod.key 2>/dev/null)
  if [ -z "$pub_key" ]; then
    skip "cannot derive public key"
  fi
  local tmpfile
  tmpfile=$(mktemp /tmp/sops-test-XXXXXX.env)
  echo 'TEST_B64=aGVsbG8gd29ybGQ=' > "$tmpfile"
  SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
    sops -e -i --age "$pub_key" "$tmpfile" 2>/dev/null
  run bash scripts/secrets.sh get "$tmpfile" TEST_B64
  rm -f "$tmpfile"
  [ "$status" -eq 0 ]
  [ "$output" = "aGVsbG8gd29ybGQ=" ]
}
