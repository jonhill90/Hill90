#!/usr/bin/env bats

# Tests for scripts/validate.sh CLI

@test "validate.sh with no args defaults to all" {
  # Should attempt to run all validations
  run bash scripts/validate.sh
  # May pass or fail depending on local env, but should not show "Unknown"
  [[ "$output" != *"Unknown"* ]]
}

@test "validate.sh help shows usage" {
  run bash scripts/validate.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "validate.sh invalid subcommand fails" {
  run bash scripts/validate.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "validate.sh traefik checks traefik config" {
  run bash scripts/validate.sh traefik
  [[ "$output" == *"Traefik"* ]]
}

@test "validate.sh compose checks compose files" {
  run bash scripts/validate.sh compose
  [[ "$output" == *"Compose"* ]]
}

# Traefik config regression tests

@test "traefik.yml has letsencrypt-dns resolver" {
  run grep "^  letsencrypt-dns:" platform/edge/traefik.yml.tmpl
  [ "$status" -eq 0 ]
}

@test "traefik.yml has no uninterpolated env vars" {
  # Traefik does not interpolate ${VAR} in its own YAML, so a variable reaching
  # the MOUNTED file is a silent misconfiguration. That is why the config is
  # rendered: the template carries the variable, the generated file must not.
  #
  # This test used to assert the invariant against platform/edge/traefik.yml
  # directly. That was correct about the danger but could not express the
  # distinction, which is why ACME_CA_SERVER stayed inert for so long — the
  # only way to satisfy it was to hardcode the CA.
  local out=/tmp/bats_validate_render.yml
  ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory \
    TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/render-traefik-config.sh >/dev/null 2>&1

  # Rendered file: no placeholders on any configuration line.
  run bash -c "grep -v '^[[:space:]]*#' $out | grep -c '\${'"
  [ "$output" -eq 0 ]

  # Template: exactly one variable, and it is the CA server.
  run bash -c "grep -v '^[[:space:]]*#' platform/edge/traefik.yml.tmpl | grep -oE '\\\$\{[A-Z_]+\}' | sort -u"
  [ "$output" = '${ACME_CA_SERVER}' ]

  rm -f "$out"
}

@test "middlewares.yml has tailscale-only middleware" {
  run grep "tailscale-only:" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 0 ]
}

@test "middlewares.yml auth uses usersFile not inline users" {
  run grep "usersFile:" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 0 ]
}

@test "middlewares.yml has no uninterpolated env vars" {
  run grep -c '\${' platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 1 ]
}

@test "middlewares.yml does NOT define mcp-auth" {
  run grep "mcp-auth:" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 1 ]
}

@test "middlewares.yml does NOT reference forwardAuth to auth:3001" {
  run grep "auth:3001" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# UI health route + compose env
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Makefile updates
# ---------------------------------------------------------------------------

@test "Makefile test target does NOT reference services/auth" {
  run bash -c 'sed -n "/^test:/,/^[a-z]/p" Makefile | grep "services/auth"'
  [ "$status" -eq 1 ]
}

@test "Makefile lint target does NOT reference services/auth" {
  run bash -c 'sed -n "/^lint:/,/^[a-z]/p" Makefile | grep "services/auth"'
  [ "$status" -eq 1 ]
}

@test "orchestrator workflow does NOT watch services/auth" {
  run grep "services/auth" .github/workflows/deploy.yml
  [ "$status" -eq 1 ]
}

@test "services/auth directory does not exist" {
  [ ! -d "services/auth" ]
}

# ---------------------------------------------------------------------------
# PR2: Auth.js integration (UI)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# PR2: API JWT middleware
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# PR2: CORS update
# ---------------------------------------------------------------------------

@test "docker-compose.infra.yml traefik has tailscale-only middleware" {
  run grep "traefik.http.routers.traefik.middlewares" deploy/compose/prod/docker-compose.infra.yml
  [[ "$output" == *"tailscale-only@file"* ]]
}
