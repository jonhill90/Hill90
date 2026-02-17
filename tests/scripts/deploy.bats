#!/usr/bin/env bats

# Tests for scripts/deploy.sh CLI

@test "deploy.sh with no args shows usage" {
  run bash scripts/deploy.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "deploy.sh help shows usage" {
  run bash scripts/deploy.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "deploy.sh invalid subcommand fails" {
  run bash scripts/deploy.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "deploy.sh infra requires compose file" {
  run bash scripts/deploy.sh infra nonexistent-env
  [ "$status" -eq 1 ]
  [[ "$output" == *"not found"* ]] || [[ "$output" == *"Error"* ]]
}

@test "deploy.sh all checks for infrastructure network" {
  # When no docker network exists, deploy all should fail with helpful message
  run bash scripts/deploy.sh all nonexistent-env
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Bug fix regression tests (post-merge fixes from e71c8e5, e72f93e)
# ---------------------------------------------------------------------------

@test "deploy.sh infra creates hill90_internal network if missing" {
  # Bug: infra compose doesn't define hill90_internal, but app services need it.
  # Fix (e71c8e5): cmd_infra creates the network after docker compose up.
  run grep "docker network create.*hill90_internal" scripts/deploy.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"hill90_internal"* ]]
}

@test "deploy.sh infra checks if hill90_internal already exists before creating" {
  # The fix should be idempotent — check with docker network inspect first.
  run grep "docker network inspect hill90_internal" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh per-service deploy does not use --remove-orphans" {
  # Bug: per-service down with --remove-orphans killed containers from other
  # compose files (e.g. deploying auth would stop api).
  # Fix (e72f93e): cmd_service uses plain 'docker compose down' without the flag.
  #
  # Extract cmd_service function body and verify no --remove-orphans.
  run bash -c 'sed -n "/^cmd_service()/,/^}/p" scripts/deploy.sh | grep -- "--remove-orphans"'
  [ "$status" -eq 1 ]  # grep should NOT find it
}

@test "deploy.sh infra DOES use --remove-orphans for full infra teardown" {
  # Infra deploy owns the full infra stack, so --remove-orphans is correct there.
  run bash -c 'sed -n "/^cmd_infra()/,/^}/p" scripts/deploy.sh | grep -- "--remove-orphans"'
  [ "$status" -eq 0 ]
}

@test "deploy.sh all deploys auth api ai mcp and ui services" {
  run grep "for svc in" scripts/deploy.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"auth"* ]]
  [[ "$output" == *"api"* ]]
  [[ "$output" == *"ai"* ]]
  [[ "$output" == *"mcp"* ]]
  [[ "$output" == *"ui"* ]]
}

@test "deploy.sh service checks hill90_internal network exists" {
  # App services require hill90_internal — deploy should fail fast if missing.
  run grep -A2 "hill90_internal" scripts/deploy.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"Deploy infrastructure first"* ]]
}

# ---------------------------------------------------------------------------
# Keycloak / Postgres separation tests
# ---------------------------------------------------------------------------

@test "deploy.sh usage lists db command" {
  run bash scripts/deploy.sh help
  [[ "$output" == *"db"* ]]
}

@test "deploy.sh db requires compose file" {
  run bash scripts/deploy.sh db nonexistent-env
  [ "$status" -eq 1 ]
  [[ "$output" == *"not found"* ]] || [[ "$output" == *"Error"* ]]
}

@test "deploy.sh dispatcher accepts db command" {
  # db must be routed through cmd_service, not rejected as unknown
  run bash scripts/deploy.sh db nonexistent-env
  [[ "$output" != *"Unknown"* ]]
}

@test "deploy.sh all does NOT include db in service loop" {
  # DB is infrastructure, not an app service
  run bash -c 'sed -n "/^cmd_all/,/^}/p" scripts/deploy.sh | grep "for svc in"'
  [[ "$output" != *"db"* ]]
}

@test "deploy.sh all includes keycloak check in docker ps" {
  run grep -E "docker ps.*keycloak" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# MinIO storage tests
# ---------------------------------------------------------------------------

@test "deploy.sh usage includes minio command" {
  run bash scripts/deploy.sh help
  [[ "$output" == *"minio"* ]]
  [[ "$output" == *"MinIO"* ]]
}

@test "deploy.sh minio is accepted by main dispatcher" {
  # Should fail on missing compose/secrets, not 'Unknown command'
  run bash scripts/deploy.sh minio nonexistent-env
  [ "$status" -eq 1 ]
  [[ "$output" != *"Unknown"* ]]
}

@test "deploy.sh all does NOT include minio in service loop" {
  # MinIO is infrastructure, not an app service — same as db
  run bash -c 'sed -n "/^cmd_all/,/^}/p" scripts/deploy.sh | grep "for svc in"'
  [[ "$output" != *"minio"* ]]
}

@test "deploy.sh cmd_service has minio case with correct compose file" {
  run bash -c 'sed -n "/^cmd_service/,/^}/p" scripts/deploy.sh | grep -A1 "minio)"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"docker-compose.minio.yml"* ]]
}
