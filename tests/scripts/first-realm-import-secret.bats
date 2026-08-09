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

@test "deploy auth runs the first-import preflight before compose can start Keycloak" {
  run bash -c '
    preflight=$(grep -n "preflight-first-realm-import-secret.sh" scripts/deploy.sh | head -n1 | cut -d: -f1)
    compose=$(awk -v after="$preflight" "NR > after && /docker compose -p.*up -d/ { print NR; exit }" scripts/deploy.sh)
    test -n "$preflight" && test -n "$compose" && test "$preflight" -lt "$compose"
  '

  [ "$status" -eq 0 ]
}
