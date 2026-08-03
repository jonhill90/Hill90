#!/usr/bin/env bats

# POSITIVE CONTROL for the runtime completeness guard in vault_load_secrets.
#
# THE GAP IT CLOSES, precisely. #651 already refuses a value vault RETURNS blank.
# It cannot refuse a variable vault never returns — an absent key is not an empty
# value, and compose substitutes the empty string for it either way.
#
# On 2026-08-03 secret/observability/grafana held one key. GRAFANA_OIDC_CLIENT_SECRET
# was ABSENT, not blank. The deploy logged
#     vault: loaded 1 variables for observability, none empty
# and Grafana started with an empty OIDC secret. SSO broke with unauthorized_client.
#
# So the first test REPLAYS that exact load and requires the guard to refuse it.
# The rest cover the surrounding behaviour, and one asserts the guard does NOT
# fire on a complete load — a guard that refuses everything is not a guard.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  # Exercise the REAL parsing logic against a controlled temp file, standing in
  # for what vault_read_kv appends. Values here are obvious fakes.
  guard() {
    local service="$1" temp_file="$2"
    local missing_vars=() required key
    required=$(bash -c "source '$ROOT/scripts/_common.sh' >/dev/null 2>&1; vault_required_vars_for_service '$service'")
    for key in $required; do
      grep -qE "^${key}=" "$temp_file" || missing_vars+=("${key}(absent)")
    done
    if [ ${#missing_vars[@]} -gt 0 ]; then
      echo "vault: ${service} — OpenBao did not supply: ${missing_vars[*]}"
      return 1
    fi
    echo "complete"
    return 0
  }
}

@test "REPLAY of the 2026-08-03 outage: one key for observability is REFUSED" {
  tf="$BATS_TEST_TMPDIR/one.env"
  printf "GRAFANA_ADMIN_PASSWORD='fake-value'\n" > "$tf"

  run guard observability "$tf"
  [ "$status" -eq 1 ]
  [[ "$output" == *"GRAFANA_OIDC_CLIENT_SECRET(absent)"* ]]
  [[ "$output" == *"SMTP_PASSWORD(absent)"* ]]
  [[ "$output" == *"ACME_EMAIL(absent)"* ]]
}

@test "the refusal NAMES the blank key, so nobody diagnoses an empty env from scratch" {
  tf="$BATS_TEST_TMPDIR/named.env"
  printf "GRAFANA_ADMIN_PASSWORD='x'\nGRAFANA_OIDC_CLIENT_SECRET='x'\nACME_EMAIL='x'\n" > "$tf"

  run guard observability "$tf"
  [ "$status" -eq 1 ]
  # Exactly the one that is missing, and not the ones that are present.
  [[ "$output" == *"SMTP_PASSWORD(absent)"* ]]
  [[ "$output" != *"GRAFANA_ADMIN_PASSWORD(absent)"* ]]
}

@test "a COMPLETE load is accepted — the guard is not a blanket refusal" {
  tf="$BATS_TEST_TMPDIR/full.env"
  printf "GRAFANA_ADMIN_PASSWORD='x'\nGRAFANA_OIDC_CLIENT_SECRET='x'\nSMTP_PASSWORD='x'\nACME_EMAIL='x'\n" > "$tf"

  run guard observability "$tf"
  [ "$status" -eq 0 ]
  [[ "$output" == *"complete"* ]]
}

@test "the auth outage shape is refused too: KC_ADMIN_PASSWORD absent" {
  tf="$BATS_TEST_TMPDIR/auth.env"
  printf "DB_USER='x'\nDB_PASSWORD='x'\nKC_ADMIN_USERNAME='x'\nVAULT_OIDC_CLIENT_SECRET='x'\n" > "$tf"

  run guard auth "$tf"
  [ "$status" -eq 1 ]
  [[ "$output" == *"KC_ADMIN_PASSWORD(absent)"* ]]
}

# NOT VACUOUS: an empty required list accepts anything. Every service that
# declares vault paths must also declare what it requires.
@test "every service with vault paths declares required vars" {
  for svc in db auth infra observability; do
    paths=$(bash -c "source '$ROOT/scripts/_common.sh' >/dev/null 2>&1; vault_paths_for_service '$svc'")
    reqs=$(bash -c "source '$ROOT/scripts/_common.sh' >/dev/null 2>&1; vault_required_vars_for_service '$svc'")
    [ -n "$paths" ]
    [ -n "$reqs" ]
  done
}

@test "the guard runs BEFORE source, so a partial load cannot be exported" {
  # Order matters: a completeness check after `source` would already have put the
  # blanks into the environment.
  #
  # Scoped to vault_load_secrets. A first version grepped the whole file and
  # matched an unrelated `set -a` in another function 250 lines earlier, so it
  # failed against correct code — the assertion was wrong, not the guard.
  body="$BATS_TEST_TMPDIR/body.sh"
  sed -n '/^vault_load_secrets()/,/^}/p' "$ROOT/scripts/_common.sh" > "$body"
  [ -s "$body" ]

  first_missing=$(grep -n 'missing_vars=()' "$body" | head -1 | cut -d: -f1)
  first_source=$(grep -n 'source "\$temp_file"' "$body" | head -1 | cut -d: -f1)
  [ -n "$first_missing" ]
  [ -n "$first_source" ]
  [ "$first_missing" -lt "$first_source" ]
}

@test "the guard lives in _common.sh, not in a lint that runs beforehand" {
  run grep -c 'vault_required_vars_for_service' "$ROOT/scripts/_common.sh"
  [ "$output" -ge 2 ]
}
