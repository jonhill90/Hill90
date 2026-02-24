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
  run grep "^  letsencrypt-dns:" platform/edge/traefik.yml
  [ "$status" -eq 0 ]
}

@test "traefik.yml has no uninterpolated env vars" {
  run grep -c '\${' platform/edge/traefik.yml
  [ "$status" -eq 1 ]
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

@test "docker-compose.infra.yml traefik has tailscale-only middleware" {
  run grep "traefik.http.routers.traefik.middlewares" deploy/compose/prod/docker-compose.infra.yml
  [[ "$output" == *"tailscale-only@file"* ]]
}

# ---------------------------------------------------------------------------
# Postgres separation (docker-compose.db.yml)
# ---------------------------------------------------------------------------

@test "docker-compose.db.yml exists" {
  [ -f "deploy/compose/prod/docker-compose.db.yml" ]
}

@test "docker-compose.db.yml defines postgres service" {
  run grep "postgres:" deploy/compose/prod/docker-compose.db.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.db.yml mounts init.sh not init.sql" {
  run grep "init.sh" deploy/compose/prod/docker-compose.db.yml
  [ "$status" -eq 0 ]
  run grep "init.sql" deploy/compose/prod/docker-compose.db.yml
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Keycloak (docker-compose.auth.yml)
# ---------------------------------------------------------------------------

@test "docker-compose.auth.yml defines keycloak service" {
  run grep "keycloak:" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.auth.yml does NOT define postgres service" {
  run grep "^  postgres:" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 1 ]
}

@test "docker-compose.auth.yml does NOT define old auth service" {
  run grep "^  auth:" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 1 ]
}

@test "docker-compose.auth.yml keycloak has edge and internal networks" {
  run grep "edge" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
  run grep "internal" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.auth.yml keycloak uses single hostname" {
  run grep "KC_HOSTNAME_ADMIN" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 1 ]
}

@test "docker-compose.auth.yml keycloak uses start command with import-realm" {
  run grep "start --import-realm" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.auth.yml healthcheck targets port 9000" {
  run grep "9000" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.auth.yml has start_period for slow Keycloak boot" {
  run grep "start_period" deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Keycloak realm config
# ---------------------------------------------------------------------------

@test "hill90-realm.json exists" {
  [ -f "platform/auth/keycloak/hill90-realm.json" ]
}

@test "hill90-realm.json is valid JSON" {
  run python3 -c "import json; json.load(open('platform/auth/keycloak/hill90-realm.json'))"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json defines hill90 realm" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['realm']=='hill90'"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json has bruteForceProtected enabled" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['bruteForceProtected']==True"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json has hill90-ui client" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); ids=[c['clientId'] for c in d['clients']]; assert 'hill90-ui' in ids"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json has hill90-api client" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); ids=[c['clientId'] for c in d['clients']]; assert 'hill90-api' in ids"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json hill90-ui disallows direct access grants" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); ui=[c for c in d['clients'] if c['clientId']=='hill90-ui'][0]; assert ui['directAccessGrantsEnabled']==False"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json hill90-ui is not public client" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); ui=[c for c in d['clients'] if c['clientId']=='hill90-ui'][0]; assert ui['publicClient']==False"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json registration is disabled" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['registrationAllowed']==False"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Keycloak theme branding
# ---------------------------------------------------------------------------

@test "hill90-realm.json sets loginTheme to hill90" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['loginTheme']=='hill90'"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json sets accountTheme to hill90" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['accountTheme']=='hill90'"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json sets adminTheme to hill90" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['adminTheme']=='hill90'"
  [ "$status" -eq 0 ]
}

@test "hill90-realm.json sets emailTheme to hill90" {
  run python3 -c "import json; d=json.load(open('platform/auth/keycloak/hill90-realm.json')); assert d['emailTheme']=='hill90'"
  [ "$status" -eq 0 ]
}

@test "setup-realm.sh contains accountTheme" {
  run grep "accountTheme" platform/auth/keycloak/setup-realm.sh
  [ "$status" -eq 0 ]
}

@test "setup-realm.sh contains adminTheme" {
  run grep "adminTheme" platform/auth/keycloak/setup-realm.sh
  [ "$status" -eq 0 ]
}

@test "setup-realm.sh contains emailTheme" {
  run grep "emailTheme" platform/auth/keycloak/setup-realm.sh
  [ "$status" -eq 0 ]
}

@test "theme directory exists for login" {
  [ -d "platform/auth/keycloak/themes/hill90/login" ]
}

@test "theme directory exists for account" {
  [ -d "platform/auth/keycloak/themes/hill90/account" ]
}

@test "theme directory exists for admin" {
  [ -d "platform/auth/keycloak/themes/hill90/admin" ]
}

@test "theme directory exists for email" {
  [ -d "platform/auth/keycloak/themes/hill90/email" ]
}

@test "login theme has theme.properties" {
  [ -f "platform/auth/keycloak/themes/hill90/login/theme.properties" ]
}

@test "account theme has theme.properties" {
  [ -f "platform/auth/keycloak/themes/hill90/account/theme.properties" ]
}

@test "admin theme has theme.properties" {
  [ -f "platform/auth/keycloak/themes/hill90/admin/theme.properties" ]
}

@test "email theme has theme.properties" {
  [ -f "platform/auth/keycloak/themes/hill90/email/theme.properties" ]
}

# ---------------------------------------------------------------------------
# mcp-auth middleware removal
# ---------------------------------------------------------------------------

@test "middlewares.yml does NOT define mcp-auth" {
  run grep "mcp-auth:" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 1 ]
}

@test "middlewares.yml does NOT reference forwardAuth to auth:3001" {
  run grep "auth:3001" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 1 ]
}

@test "docker-compose.mcp.yml does NOT reference mcp-auth middleware" {
  run grep "mcp-auth" deploy/compose/prod/docker-compose.mcp.yml
  [ "$status" -eq 1 ]
}

@test "docker-compose.mcp.yml still has mcp-strip middleware" {
  run grep "mcp-strip@file" deploy/compose/prod/docker-compose.mcp.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# UI health route + compose env
# ---------------------------------------------------------------------------

@test "UI health route probes Keycloak not old auth service" {
  run grep "Keycloak" services/ui/src/app/api/services/health/route.ts
  [ "$status" -eq 0 ]
}

@test "UI health route does NOT reference port 3001" {
  run grep "3001" services/ui/src/app/api/services/health/route.ts
  [ "$status" -eq 1 ]
}

@test "UI health route uses KEYCLOAK_INTERNAL_URL env var" {
  run grep "KEYCLOAK_INTERNAL_URL" services/ui/src/app/api/services/health/route.ts
  [ "$status" -eq 0 ]
}

@test "docker-compose.ui.yml has KEYCLOAK_INTERNAL_URL" {
  run grep "KEYCLOAK_INTERNAL_URL" deploy/compose/prod/docker-compose.ui.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Makefile updates
# ---------------------------------------------------------------------------

@test "Makefile has deploy-db target" {
  run grep "deploy-db:" Makefile
  [ "$status" -eq 0 ]
}

@test "Makefile test target does NOT reference services/auth" {
  run bash -c 'sed -n "/^test:/,/^[a-z]/p" Makefile | grep "services/auth"'
  [ "$status" -eq 1 ]
}

@test "Makefile lint target does NOT reference services/auth" {
  run bash -c 'sed -n "/^lint:/,/^[a-z]/p" Makefile | grep "services/auth"'
  [ "$status" -eq 1 ]
}

@test "Makefile format target does NOT reference services/auth" {
  run bash -c 'sed -n "/^format:/,/^[a-z]/p" Makefile | grep "services/auth"'
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# .env.example Keycloak vars
# ---------------------------------------------------------------------------

@test ".env.example has KC_ADMIN_USERNAME" {
  run grep "KC_ADMIN_USERNAME" deploy/compose/prod/.env.example
  [ "$status" -eq 0 ]
}

@test ".env.example has KC_ADMIN_PASSWORD" {
  run grep "KC_ADMIN_PASSWORD" deploy/compose/prod/.env.example
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# SMTP secrets
# ---------------------------------------------------------------------------

@test "prod.enc.env.example has SMTP_PASSWORD" {
  run grep "SMTP_PASSWORD" infra/secrets/prod.enc.env.example
  [ "$status" -eq 0 ]
}

@test "setup-realm.sh references SMTP_PASSWORD from SOPS" {
  run grep "SMTP_PASSWORD" platform/auth/keycloak/setup-realm.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# GitHub Actions workflows
# ---------------------------------------------------------------------------

@test "orchestrator workflow watches keycloak realm config path" {
  run grep "platform/auth/keycloak" .github/workflows/deploy.yml
  [ "$status" -eq 0 ]
}

@test "orchestrator workflow does NOT watch services/auth" {
  run grep "services/auth" .github/workflows/deploy.yml
  [ "$status" -eq 1 ]
}

@test "deploy-auth workflow is dispatch-only (no push trigger)" {
  run grep "^  push:" .github/workflows/deploy-auth.yml
  [ "$status" -eq 1 ]
}

@test "deploy-db workflow exists" {
  [ -f ".github/workflows/deploy-db.yml" ]
}

@test "orchestrator workflow watches docker-compose.db.yml" {
  run grep "docker-compose.db.yml" .github/workflows/deploy.yml
  [ "$status" -eq 0 ]
}

@test "orchestrator workflow watches postgres init scripts" {
  run grep "platform/data/postgres" .github/workflows/deploy.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Auth service deletion
# ---------------------------------------------------------------------------

@test "services/auth directory does not exist" {
  [ ! -d "services/auth" ]
}

# ---------------------------------------------------------------------------
# PR2: Auth.js integration (UI)
# ---------------------------------------------------------------------------

@test "auth.ts exists in UI service" {
  [ -f "services/ui/src/auth.ts" ]
}

@test "auth.ts uses Keycloak provider" {
  run grep "Keycloak" services/ui/src/auth.ts
  [ "$status" -eq 0 ]
}

@test "nextauth route handler exists" {
  [ -f "services/ui/src/app/api/auth/[...nextauth]/route.ts" ]
}

@test "docker-compose.ui.yml has AUTH_KEYCLOAK_ID" {
  run grep "AUTH_KEYCLOAK_ID" deploy/compose/prod/docker-compose.ui.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.ui.yml has AUTH_SECRET" {
  run grep "AUTH_SECRET" deploy/compose/prod/docker-compose.ui.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.ui.yml has AUTH_KEYCLOAK_ISSUER" {
  run grep "AUTH_KEYCLOAK_ISSUER" deploy/compose/prod/docker-compose.ui.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# PR2: API JWT middleware
# ---------------------------------------------------------------------------

@test "API jest.config.js uses ts-jest preset" {
  run grep "ts-jest" services/api/jest.config.js
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# PR2: CORS update
# ---------------------------------------------------------------------------

@test "middlewares.yml CORS allows auth.hill90.com" {
  run grep "auth.hill90.com" platform/edge/dynamic/middlewares.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# PR2: .env.example auth integration vars
# ---------------------------------------------------------------------------

@test ".env.example has AUTH_SECRET" {
  run grep "AUTH_SECRET" deploy/compose/prod/.env.example
  [ "$status" -eq 0 ]
}

@test ".env.example has AUTH_KEYCLOAK_ID" {
  run grep "AUTH_KEYCLOAK_ID" deploy/compose/prod/.env.example
  [ "$status" -eq 0 ]
}

@test ".env.example has AUTH_KEYCLOAK_SECRET" {
  run grep "AUTH_KEYCLOAK_SECRET" deploy/compose/prod/.env.example
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# MinIO compose file tests
# ---------------------------------------------------------------------------

@test "docker-compose.minio.yml exists" {
  [ -f deploy/compose/prod/docker-compose.minio.yml ]
}

@test "docker-compose.minio.yml pins volume name explicitly" {
  # Without explicit name, Docker Compose prefixes project name (e.g. prod_minio-data)
  run grep "name: minio-data" deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.minio.yml uses pinned minio image (not latest)" {
  run grep "minio/minio:" deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 0 ]
  [[ "$output" == *"RELEASE"* ]]
  [[ "$output" != *"latest"* ]]
}

@test "docker-compose.minio.yml uses tailscale-only middleware" {
  run grep "tailscale-only@file" deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.minio.yml uses letsencrypt-dns cert resolver (not letsencrypt)" {
  run grep "certresolver=letsencrypt-dns" deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.minio.yml does NOT expose S3 API via Traefik" {
  # S3 API (9000) is internal-only — only console (9001) has a Traefik router
  run grep "loadbalancer.server.port=9000" deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 1 ]
}
