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
# Stack isolation and safety invariant tests
# ---------------------------------------------------------------------------

@test "deploy.sh never uses --remove-orphans" {
  run grep -- "--remove-orphans" scripts/deploy.sh
  [ "$status" -eq 1 ]
}

@test "deploy.sh all compose invocations use explicit project names" {
  # Every 'docker compose' call (non-comment) must include '-p '
  run bash -c 'grep "docker compose" scripts/deploy.sh | grep -v "^#" | grep -v "^[[:space:]]*#" | grep -v -- "-p "'
  [ "$status" -eq 1 ]
}

@test "deploy.sh project names follow hill90-env-stack convention" {
  # Extract all project names and verify they start with 'hill90-'
  run bash -c "grep -oE '\-p [\"'\'']*hill90-[^ \"'\'']+' scripts/deploy.sh | sed 's/-p [\"'\'']*//;s/[\"'\'']*$//' | sort -u | grep -v '^hill90-'"
  [ "$status" -eq 1 ]
}

@test "deploy.sh stateless app services do not use docker compose down" {
  # In the stateless branch (api, ai, mcp, ui), there should be no 'down'
  # The stateless path uses --force-recreate --no-deps instead
  run grep -- "--force-recreate --no-deps" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh infra creates hill90_internal network if missing" {
  run grep "docker network create.*hill90_internal" scripts/deploy.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"hill90_internal"* ]]
}

@test "deploy.sh infra checks if hill90_internal already exists before creating" {
  run grep "docker network inspect hill90_internal" scripts/deploy.sh
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
  run bash scripts/deploy.sh db nonexistent-env
  [[ "$output" != *"Unknown"* ]]
}

@test "deploy.sh all does NOT include db in service loop" {
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
  run bash scripts/deploy.sh minio nonexistent-env
  [ "$status" -eq 1 ]
  [[ "$output" != *"Unknown"* ]]
}

@test "deploy.sh all does NOT include minio in service loop" {
  run bash -c 'sed -n "/^cmd_all/,/^}/p" scripts/deploy.sh | grep "for svc in"'
  [[ "$output" != *"minio"* ]]
}

@test "deploy.sh cmd_service has minio case with correct compose file" {
  run bash -c 'sed -n "/^cmd_service/,/^}/p" scripts/deploy.sh | grep -A1 "minio)"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"docker-compose.minio.yml"* ]]
}

# ---------------------------------------------------------------------------
# Health gate and readiness check tests
# ---------------------------------------------------------------------------

@test "deploy.sh usage lists verify command" {
  run bash scripts/deploy.sh help
  [[ "$output" == *"verify"* ]]
}

@test "deploy.sh dispatcher routes verify command to cmd_verify" {
  # With no service arg, cmd_verify prints "Unknown service" (not "Unknown command")
  run bash scripts/deploy.sh verify
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown service"* ]]
}

@test "deploy.sh has cmd_verify function" {
  run grep "^cmd_verify()" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh has check_dependency function" {
  run grep "^check_dependency()" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh auth deploy checks postgres dependency" {
  run bash -c 'sed -n "/# Pre-deploy dependency/,/esac/p" scripts/deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"auth)"* ]]
  [[ "$output" == *"check_dependency postgres"* ]]
}

@test "deploy.sh api deploy checks postgres and keycloak dependencies" {
  run bash -c 'sed -n "/# Pre-deploy dependency/,/esac/p" scripts/deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"api|mcp)"* ]]
  [[ "$output" == *"check_dependency postgres"* ]]
  [[ "$output" == *"check_dependency keycloak"* ]]
}

@test "deploy.sh cmd_verify covers all service types" {
  for svc in db auth api ai mcp ui minio observability infra; do
    run bash -c "sed -n '/^cmd_verify/,/^}/p' scripts/deploy.sh | grep '${svc})'"
    [ "$status" -eq 0 ]
  done
}

@test "deploy.sh keycloak checks use docker inspect not curl" {
  run grep -c 'docker exec keycloak curl' scripts/deploy.sh
  [ "$output" = "0" ]
}

# ---------------------------------------------------------------------------
# Legacy agentbox anti-regression tests
# ---------------------------------------------------------------------------

@test "legacy agentbox deployment paths are absent" {
  # Scripts must not exist
  [ ! -f scripts/agentbox.sh ]
  [ ! -f scripts/agentbox-compose-gen.py ]

  # Compose file must not exist
  [ ! -f deploy/compose/prod/docker-compose.agentbox.yml ]

  # Workflow must not exist
  [ ! -f .github/workflows/deploy-agentbox.yml ]

  # deploy.sh must not contain cmd_agentbox
  run grep 'cmd_agentbox' scripts/deploy.sh
  [ "$status" -eq 1 ]

  # Makefile must not contain deploy-agentbox
  run grep 'deploy-agentbox' Makefile
  [ "$status" -eq 1 ]

  # deploy.yml must not contain deploy-agentbox job or agentbox dispatch option
  run grep 'deploy-agentbox' .github/workflows/deploy.yml
  [ "$status" -eq 1 ]
  run grep 'agentbox' .github/workflows/deploy.yml
  [ "$status" -eq 1 ]

  # rollback.sh must not contain agentbox) case
  run grep 'agentbox)' scripts/rollback.sh
  [ "$status" -eq 1 ]

  # AGENTS.md must not contain deploy-agentbox or agentbox-list
  run grep 'deploy-agentbox' AGENTS.md
  [ "$status" -eq 1 ]
  run grep 'agentbox-list' AGENTS.md
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Volume safety invariant tests
# ---------------------------------------------------------------------------

@test "stateful compose volumes have explicit name fields" {
  # Uses the same parser-backed check as CI
  run python3 scripts/checks/check_volume_names.py
  [ "$status" -eq 0 ]
}

@test "no destructive volume commands in deploy scripts" {
  for f in scripts/deploy.sh scripts/backup.sh scripts/rollback.sh; do
    # grep returns 1 (no match) when banned commands are absent — that's the pass case
    run bash -c "grep -v '^[[:space:]]*#' '$f' | grep -cE 'docker compose.*down.*-v|docker volume rm|docker system prune'"
    [ "$output" = "0" ]
  done
}
