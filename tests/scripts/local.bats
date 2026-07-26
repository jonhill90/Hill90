#!/usr/bin/env bats
# Local development CLI and local/prod parity.

@test "local.sh exists and is executable" {
  [ -x scripts/local.sh ]
}

@test "local.sh with no args shows usage" {
  run bash scripts/local.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: local.sh"* ]]
}

@test "local.sh rejects an unknown command" {
  run bash scripts/local.sh definitely-not-a-command
  [ "$status" -eq 1 ]
}

@test "local.sh uses the production compose files, not a forked dev tree" {
  run grep -c 'COMPOSE_DIR="deploy/compose/prod"' scripts/local.sh
  [ "$output" = "1" ]
}

@test "no forked dev compose tree exists" {
  [ ! -d deploy/compose/dev ]
}

@test "local overrides exist for both stacks" {
  [ -f deploy/compose/overrides/local.infra.yml ]
  [ -f deploy/compose/overrides/local.observability.yml ]
}

@test ".env.local.example exists and .env.local is gitignored" {
  [ -f .env.local.example ]
  run grep -qE '^\.env\.local$' .gitignore
  [ "$status" -eq 0 ]
}

@test "local.sh never targets the VPS" {
  run grep -nE 'ssh |remote\.hill90|deploy@' scripts/local.sh
  [ "$status" -eq 1 ]
}

# --- The parity property this whole design rests on -------------------------

@test "compose files resolve to production names with no environment set" {
  run docker compose -f deploy/compose/prod/docker-compose.infra.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"container_name: traefik"* ]]
  [[ "$output" == *"name: hill90_edge"* ]]
  [[ "$output" == *"traefik.hill90.com"* ]]
  [[ "$output" == *"tailscale-only@file"* ]]
  [[ "$output" == *"letsencrypt-dns"* ]]
}

@test "observability resolves to production names with no environment set" {
  run docker compose -f deploy/compose/prod/docker-compose.observability.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"container_name: grafana"* ]]
  [[ "$output" == *"grafana.hill90.com"* ]]
}

@test "vault resolves to production names with no environment set" {
  run docker compose -f deploy/compose/prod/docker-compose.vault.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"container_name: openbao"* ]]
  [[ "$output" == *"vault.hill90.com"* ]]
}

@test "local env produces local names from the same files" {
  run docker compose --env-file .env.local.example \
        -f deploy/compose/prod/docker-compose.infra.yml \
        -f deploy/compose/overrides/local.infra.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"traefik.localtest.me"* ]]
  [[ "$output" == *"hill90dev_edge"* ]]
  [[ "$output" != *"tailscale-only@file"* ]]
}

@test "configuration surface check passes" {
  run python3 scripts/checks/check_env_surface.py
  [ "$status" -eq 0 ]
}

# --- Teardown ---------------------------------------------------------------

@test "deploy.sh exposes teardown" {
  run bash scripts/deploy.sh help
  [[ "$output" == *"teardown"* ]]
}

@test "deploy.sh teardown rejects an unknown stack" {
  run bash scripts/deploy.sh teardown api prod
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown stack for teardown"* ]]
}

@test "deploy.sh teardown never removes volumes" {
  run bash -c 'sed -n "/^cmd_teardown/,/^}/p" scripts/deploy.sh | grep -E "down .*(-v|--volumes)|volume rm"'
  [ "$status" -eq 1 ]
}

@test "deploy.sh teardown backs up before removing anything" {
  # The backup call must appear before the compose down within cmd_teardown.
  run bash -c '
    body=$(sed -n "/^cmd_teardown/,/^}$/p" scripts/deploy.sh)
    b=$(echo "$body" | grep -n "backup\.sh" | head -1 | cut -d: -f1)
    d=$(echo "$body" | grep -n "compose .*down" | head -1 | cut -d: -f1)
    [ -n "$b" ] && [ -n "$d" ] && [ "$b" -lt "$d" ]'
  [ "$status" -eq 0 ]
}

@test "local.sh reset requires typed confirmation" {
  run bash -c 'sed -n "/^cmd_reset/,/^}/p" scripts/local.sh | grep -c "read -r -p"'
  [ "$output" = "1" ]
}

@test "prometheus is routed locally but NOT in production" {
  # Production reaches Prometheus through Grafana; it has no router there.
  run docker compose -f deploy/compose/prod/docker-compose.observability.yml config
  [ "$status" -eq 0 ]
  [[ "$output" != *"routers.prometheus"* ]]

  # Locally it is routed, so the targets page and expression browser work.
  run docker compose --env-file .env.local.example \
        -f deploy/compose/prod/docker-compose.observability.yml \
        -f deploy/compose/overrides/local.observability.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"routers.prometheus"* ]]
  [[ "$output" == *"prometheus.localtest.me"* ]]
}

@test "local health checks follow redirects" {
  # Prometheus sends /graph to /query and Grafana sends / to /login; asserting
  # on the first response would fail on pages that work.
  run bash -c 'sed -n "/^check_http/,/^}/p" scripts/local.sh | grep -c -- "curl -sL"'
  [ "$output" = "1" ]
}

# --- Local vault parity (JON-50) --------------------------------------------

@test "a local override exists for every prod stack" {
  for stack in infra observability vault; do
    [ -f "deploy/compose/overrides/local.${stack}.yml" ]
  done
}

@test "local.sh brings up the vault stack" {
  run grep -c "compose_vault up -d" scripts/local.sh
  [ "$output" = "1" ]
}

@test "local.sh exposes a vault subcommand" {
  run bash scripts/local.sh
  [[ "$output" == *"vault"* ]]
}

@test "local vault state is gitignored and outside /opt" {
  run grep -qxF ".local-vault/" .gitignore
  [ "$status" -eq 0 ]
  run bash -c 'grep -c "LOCAL_VAULT_DIR=\"\$PROJECT_ROOT/.local-vault\"" scripts/local.sh'
  [ "$output" = "1" ]
}

@test "local vault never points at the production secrets file" {
  # VAULT_SECRETS_FILE must resolve under LOCAL_VAULT_DIR (which test above
  # pins to .local-vault), and must never name the production secrets file.
  run bash -c 'sed -n "/^cmd_vault/,/^}/p" scripts/local.sh | grep "VAULT_SECRETS_FILE"'
  [ "$status" -eq 0 ]
  [[ "$output" == *'LOCAL_VAULT_DIR'* ]]
  [[ "$output" != *"infra/secrets"* ]]
  # And nothing in the local path may reference the prod secrets file at all.
  run bash -c 'sed -n "/^cmd_vault/,/^}/p" scripts/local.sh | grep -c "prod.enc.env"'
  [ "$output" = "0" ]
}

@test "local vault uses vault.sh unmodified, via its documented env overrides" {
  # vault.sh reads each of these as a ${VAR:-<prod default>}, so local can point
  # them elsewhere without the script differing by a byte from the VPS copy.
  run grep -c 'VAULT_CONTAINER:-' scripts/vault.sh
  [ "$output" = "1" ]
  run grep -c 'VAULT_UNSEAL_KEY_PATH:-' scripts/vault.sh
  [ "$output" = "1" ]
  run grep -c 'VAULT_ROOT_TOKEN_PATH:-' scripts/vault.sh
  [ "$output" = "1" ]
  run grep -c 'VAULT_SECRETS_FILE:-' scripts/vault.sh
  [ "$output" = "1" ]
}

@test "vault compose resolves to production names with no environment set" {
  run docker compose -f deploy/compose/prod/docker-compose.vault.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"container_name: openbao"* ]]
  [[ "$output" == *"vault.hill90.com"* ]]
  [[ "$output" == *"tailscale-only@file"* ]]
}

@test "local vault override produces local routing from the same file" {
  run docker compose --env-file .env.local.example \
        -f deploy/compose/prod/docker-compose.vault.yml \
        -f deploy/compose/overrides/local.vault.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"vault.localtest.me"* ]]
  [[ "$output" != *"tailscale-only@file"* ]]
}
