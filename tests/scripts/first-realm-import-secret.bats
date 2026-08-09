#!/usr/bin/env bats

# Regression coverage for h#809. The production preflight queries Postgres to
# distinguish a first Keycloak realm import from a routine auth deploy; these
# tests replace Docker with a tiny deterministic stand-in and use only dummy
# secret values.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CHECK="$ROOT/scripts/checks/preflight-first-realm-import-secret.sh"
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"

  cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"pg_catalog.pg_tables"* ]]; then
  printf '%s\n' "${FAKE_REALM_SCHEMA:-f}"
elif [[ "$*" == *"FROM realm"* ]]; then
  printf '%s\n' "${FAKE_PLATFORM_REALM:-f}"
else
  printf 'unexpected docker invocation: %s\n' "$*" >&2
  exit 99
fi
EOF
  chmod +x "$STUB/docker"
}

build_deploy_harness() {
  CTL="$BATS_TEST_TMPDIR/deploy-path"
  mkdir -p "$CTL/scripts/checks"
  cp "${DEPLOY_SOURCE:-$ROOT/scripts/deploy.sh}" "$CTL/scripts/deploy.sh"
  cp "$CHECK" "$CTL/scripts/checks/preflight-first-realm-import-secret.sh"

  cat > "$CTL/scripts/backup.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$CTL/scripts/keycloak.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$CTL/scripts/backup.sh" "$CTL/scripts/keycloak.sh"

  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = exec-env ]; then
  bash -c "$3"
  exit $?
fi
exit 99
EOF
  chmod +x "$STUB/sops"

cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"pg_catalog.pg_tables"* ]]; then
  printf '%s\n' "${FAKE_REALM_SCHEMA:-f}"
elif [[ "$*" == *"FROM realm"* ]]; then
  printf '%s\n' "${FAKE_PLATFORM_REALM:-f}"
elif [[ "$*" == *"SELECT 1"* ]]; then
  printf '1\n'
elif [ "$1" = compose ]; then
  if [[ "$*" == *" up -d"* ]]; then
    : > "$AUTH_COMPOSE_SENTINEL"
  fi
elif [ "$1" = inspect ] && [[ "$*" == *"--format="* ]]; then
  printf 'healthy\n'
fi
EOF
  chmod +x "$STUB/docker"

  cat > "$CTL/harness.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$CTL/scripts"
ensure_age_key() { :; }
require_file() { :; }
secret_value() { printf 'hill90'; }
die() { printf 'DIE: %s\\n' "\$*" >&2; exit 97; }
warn() { printf 'WARN: %s\\n' "\$*" >&2; }
info() { :; }
vault_available() { return 1; }
vault_approle_credentials_present() { return 1; }
cmd_verify() { :; }
prune_builder_cache() { :; }
EOF
  sed -n '/^cmd_service() {/,/^}/p' "$CTL/scripts/deploy.sh" >> "$CTL/harness.sh"
}

@test "FIRST IMPORT: an absent HILL90_UI_CLIENT_SECRET refuses before import" {
  run env -u HILL90_UI_CLIENT_SECRET FAKE_REALM_SCHEMA=f \
    bash "$CHECK" hill90 keycloak platform

  [ "$status" -eq 1 ]
  [[ "$output" == *"HILL90_UI_CLIENT_SECRET is missing"* ]]
}

@test "FIRST IMPORT: the literal realm-template placeholder refuses" {
  run env HILL90_UI_CLIENT_SECRET='${HILL90_UI_CLIENT_SECRET}' FAKE_REALM_SCHEMA=f \
    bash "$CHECK" hill90 keycloak platform

  [ "$status" -eq 1 ]
  [[ "$output" == *"literal placeholder"* ]]
}

@test "FIRST IMPORT: a nonempty synthetic secret permits import" {
  run env HILL90_UI_CLIENT_SECRET='synthetic-ui-secret-0123456789' FAKE_REALM_SCHEMA=f \
    bash "$CHECK" hill90 keycloak platform

  [ "$status" -eq 0 ]
  [[ "$output" == *"preflight passed"* ]]
  [[ "$output" != *"synthetic-ui-secret-0123456789"* ]]
}

@test "ROUTINE DEPLOY: an existing platform realm permits an absent secret" {
  run env -u HILL90_UI_CLIENT_SECRET FAKE_REALM_SCHEMA=t FAKE_PLATFORM_REALM=t \
    bash "$CHECK" hill90 keycloak platform

  [ "$status" -eq 0 ]
  [[ "$output" == *"already exists"* ]]
}

@test "DEPLOY PATH: a failed first-import preflight aborts before compose can start Keycloak" {
  build_deploy_harness
  sentinel="$BATS_TEST_TMPDIR/auth-compose-started"

  run env -u HILL90_UI_CLIENT_SECRET FAKE_REALM_SCHEMA=f \
    AUTH_COMPOSE_SENTINEL="$sentinel" bash -c "source '$CTL/harness.sh'; cmd_service auth prod"

  [ "$status" -eq 97 ]
  [[ "$output" == *"first-realm-import secret preflight failed"* ]]
  [ ! -e "$sentinel" ]
}

@test "DEPLOY PATH: an existing realm permits progress to the auth compose-start sentinel" {
  build_deploy_harness
  sentinel="$BATS_TEST_TMPDIR/auth-compose-started"

  run env -u HILL90_UI_CLIENT_SECRET FAKE_REALM_SCHEMA=t FAKE_PLATFORM_REALM=t \
    AUTH_COMPOSE_SENTINEL="$sentinel" bash -c "source '$CTL/harness.sh'; cmd_service auth prod"

  [ "$status" -eq 0 ]
  [ -e "$sentinel" ]
}

@test "MUTATION CONTROL: bypassing the deploy-path preflight reaches compose on a missing secret" {
  mutated="$BATS_TEST_TMPDIR/deploy-without-preflight.sh"
  sed '/if ! sops exec-env "\$secrets_file" \\/,/^        fi$/d' "$ROOT/scripts/deploy.sh" > "$mutated"
  DEPLOY_SOURCE="$mutated" build_deploy_harness
  sentinel="$BATS_TEST_TMPDIR/auth-compose-started"

  run env -u HILL90_UI_CLIENT_SECRET FAKE_REALM_SCHEMA=f \
    AUTH_COMPOSE_SENTINEL="$sentinel" bash -c "source '$CTL/harness.sh'; cmd_service auth prod"

  [ "$status" -eq 0 ]
  [ -e "$sentinel" ]
}
