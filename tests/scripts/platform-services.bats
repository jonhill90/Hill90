#!/usr/bin/env bats

# Tests for Postgres and Keycloak as PLATFORM services (JON-55).
#
# These two were deleted in #495 because they looked like application
# dependencies: Postgres created hill90_api / hill90_akm / hill90_litellm, and
# the Keycloak realm carried the application's own OIDC clients. They are back
# as platform primitives — the open-source counterparts to Azure Database for
# PostgreSQL and Microsoft Entra ID (docs/decisions/platform-primitives.md).
#
# Every test here guards the distinction that makes the restoration valid.
# If these start failing, the platform layer has drifted back into being an
# application layer, which is the exact mistake that caused the deletion.

# ---------------------------------------------------------------------------
# Postgres owns platform databases only
# ---------------------------------------------------------------------------

@test "postgres init creates the keycloak database" {
  run grep -F "CREATE DATABASE keycloak" platform/data/postgres/init.sh
  [ "$status" -eq 0 ]
}

@test "postgres init creates no application databases" {
  # The three the pre-strip version created. Any of them reappearing means
  # Postgres is once again an application dependency.
  #
  # Comment lines are stripped first: the file names these three in prose to
  # explain why they are gone, and matching that text would make the guard
  # fail on its own documentation.
  run python3 -c "
import re
body = [l for l in open('platform/data/postgres/init.sh')
        if not re.match(r'\s*(#|--)', l)]
found = [db for db in ('hill90_api', 'hill90_akm', 'hill90_litellm')
         if any(db in l for l in body)]
assert not found, found
"
  [ "$status" -eq 0 ]
}

@test "postgres init is executable" {
  # Postgres runs files in docker-entrypoint-initdb.d directly. A 644 init.sh
  # fails at runtime with 'bad interpreter: Permission denied' and the database
  # comes up with no keycloak database at all.
  [ -x platform/data/postgres/init.sh ]
}

# ---------------------------------------------------------------------------
# The Keycloak realm is a platform realm, not the application's realm
# ---------------------------------------------------------------------------

@test "the platform realm is named platform" {
  run python3 -c "import json;print(json.load(open('platform/auth/keycloak/platform-realm.json'))['realm'])"
  [ "$status" -eq 0 ]
  [ "$output" = "platform" ]
}

@test "the platform realm contains the openbao client" {
  run python3 -c "
import json
r = json.load(open('platform/auth/keycloak/platform-realm.json'))
assert 'hill90-vault' in [c['clientId'] for c in r.get('clients', [])]
"
  [ "$status" -eq 0 ]
}

@test "the platform realm contains no application clients" {
  # hill90-ui and hill90-api belong to the extracted application, which is one
  # tenant among several and brings its own realm.
  run python3 -c "
import json
r = json.load(open('platform/auth/keycloak/platform-realm.json'))
ids = [c['clientId'] for c in r.get('clients', [])]
bad = [i for i in ids if i in ('hill90-ui', 'hill90-api')]
assert not bad, bad
"
  [ "$status" -eq 0 ]
}

@test "the platform realm requires TLS, so production is not relaxed by default" {
  # local.sh relaxes this on the RUNNING realm for plain-HTTP local dev. If the
  # shipped file ever says NONE, production silently accepts unencrypted auth.
  run python3 -c "
import json
r = json.load(open('platform/auth/keycloak/platform-realm.json'))
assert r.get('sslRequired') != 'NONE', r.get('sslRequired')
"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# OpenBao SSO against Keycloak — platform-to-platform
# ---------------------------------------------------------------------------

@test "the OIDC admin policy exists" {
  [ -f platform/vault/policies/policy-oidc-admin.hcl ]
}

@test "vault.sh exposes setup-oidc" {
  run bash scripts/vault.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"setup-oidc"* ]]
}

@test "setup-oidc targets the platform realm by default" {
  run grep -F 'VAULT_OIDC_DISCOVERY_URL:-https://auth.hill90.com/realms/platform' scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "setup-oidc redirect URIs default to the production vault URL" {
  # Parameterised so local rehearsal can point elsewhere, but an unset
  # environment must still produce exactly what production had.
  run grep -F 'VAULT_PUBLIC_URL:-https://vault.hill90.com' scripts/vault.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Deploy wiring
# ---------------------------------------------------------------------------

@test "deploy.sh dispatches db and auth" {
  run grep -E '^\s+(db|auth)\)' scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "auth deploys after db, because Keycloak stores realms in Postgres" {
  run python3 -c "
import yaml
w = yaml.safe_load(open('.github/workflows/deploy.yml'))
assert 'deploy-db' in w['jobs']['deploy-auth']['needs'], w['jobs']['deploy-auth']['needs']
"
  [ "$status" -eq 0 ]
}

@test "an observability change does not deploy auth or db" {
  # The dorny filters were briefly miswired so that 'observability' matched
  # platform/auth/keycloak/** and never matched platform/observability/**.
  run python3 -c "
import yaml
w = yaml.safe_load(open('.github/workflows/deploy.yml'))
f = yaml.safe_load(w['jobs']['changes']['steps'][1]['with']['filters'])
assert 'platform/observability/**' in f['observability'], f['observability']
assert 'platform/auth/keycloak/**' not in f['observability'], f['observability']
"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Local parity: production values remain the defaults
# ---------------------------------------------------------------------------

@test "the auth stack defaults to the production hostname with no environment set" {
  run grep -F 'KC_HOSTNAME:-https://auth.hill90.com' deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "local overrides never fork the compose tree" {
  # The whole local-dev contract: overrides layer on the prod files, they do not
  # replace them.
  for f in deploy/compose/overrides/local.auth.yml deploy/compose/overrides/local.db.yml; do
    [ -f "$f" ]
    run grep -F "image:" "$f"
    [ "$status" -ne 0 ]
  done
}
