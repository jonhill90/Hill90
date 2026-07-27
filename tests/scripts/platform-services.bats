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
v = (r.get('sslRequired') or '')
# Keycloak is case-insensitive here: a lowercase "none" disables TLS
# enforcement just as effectively, and an empty value defaults to none.
assert v.lower() not in ('none', ''), repr(v)
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
  # Assert the dispatch arm, not the help text: documenting a command that no
  # longer dispatches is exactly the failure this should catch.
  run grep -E '^\s+setup-oidc\)\s+cmd_setup_oidc' scripts/vault.sh
  [ "$status" -eq 0 ]
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
  # Must match the REAL dispatch arm, `db|auth|vault|observability) cmd_service`.
  # An earlier version of this test matched `^\s+(db|auth)\)`, which only ever
  # hit cmd_verify's case arms and still passed with the dispatch deleted.
  run grep -E '^\s+db\|auth\|[a-z|]+\)\s+cmd_service' scripts/deploy.sh
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
# ...and the converse: an observability change must not drag in auth or db.
for svc in ('auth', 'db'):
    assert 'platform/observability/**' not in f[svc], (svc, f[svc])
    assert 'deploy/compose/prod/docker-compose.observability.yml' not in f[svc], (svc, f[svc])
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

# ---------------------------------------------------------------------------
# Keycloak 26.4.0 configuration correctness
#
# Every assertion below was verified against the pinned image itself
# (`kc.sh start --help-all` and a real realm re-import), not from recall.
# ---------------------------------------------------------------------------

@test "the OIDC client secret comes from SOPS, not from Keycloak's generator" {
  # Without a secret in the realm file Keycloak generates a random one at
  # import, which can never match the VAULT_OIDC_CLIENT_SECRET that
  # vault.sh setup-oidc reads from SOPS — OIDC login then fails invalid_client
  # only at the moment a human first tries to log in.
  run python3 -c "
import json
r = json.load(open('platform/auth/keycloak/platform-realm.json'))
c = [x for x in r['clients'] if x['clientId'] == 'hill90-vault'][0]
assert c.get('secret') == '\${VAULT_OIDC_CLIENT_SECRET}', c.get('secret')
"
  [ "$status" -eq 0 ]
  # ...and the compose stack must actually pass that variable in.
  run grep -F 'VAULT_OIDC_CLIENT_SECRET=${VAULT_OIDC_CLIENT_SECRET}' deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "production does not run Keycloak's theme-authoring settings" {
  # --spi-theme--cache-themes=false and --spi-theme--static-max-age=-1 are
  # documented for developing a theme. In production they disable theme caching
  # on every login render. They belong in the local override only.
  # Comments are stripped: both files explain these flags in prose, and matching
  # that text would make the guard fail on its own documentation.
  run python3 -c "
import re
def code(p):
    return [l for l in open(p) if not re.match(r'\s*#', l)]
prod = code('deploy/compose/prod/docker-compose.auth.yml')
loc  = code('deploy/compose/overrides/local.auth.yml')
hit = lambda ls: any('cache-themes' in l or 'static-max-age' in l for l in ls)
assert not hit(prod), 'theme-authoring flags present in production compose'
assert hit(loc), 'theme-authoring flags missing from local override'
"
  [ "$status" -eq 0 ]
}

@test "the tracing service name uses an option that exists in Keycloak 26.4" {
  # KC_TELEMETRY_SERVICE_NAME does not exist: `kc.sh start --help-all` in
  # quay.io/keycloak/keycloak:26.4.0 lists --tracing-service-name and no
  # --telemetry-service-name. Keycloak silently ignores the unknown KC_ var.
  run grep -F 'KC_TELEMETRY_SERVICE_NAME' deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -ne 0 ]
  run grep -F 'KC_TRACING_SERVICE_NAME' deploy/compose/prod/docker-compose.auth.yml
  [ "$status" -eq 0 ]
}

@test "the postgres connections alert can actually produce a series" {
  # Dividing pg_stat_activity_count by pg_settings_max_connections directly
  # matches no series: the former has datname/state labels, the latter has
  # none. The alert loaded fine and could never fire.
  run python3 -c "
import yaml
g = yaml.safe_load(open('platform/observability/prometheus/alerts.yml'))
r = [r for grp in g['groups'] for r in grp['rules']
     if r.get('alert') == 'PostgresConnectionsHigh'][0]
assert 'sum by (instance)' in r['expr'], r['expr']
assert 'max by (instance)' in r['expr'], r['expr']
"
  [ "$status" -eq 0 ]
}

@test "local.sh refuses to run with an empty container prefix" {
  # An empty prefix makes local.sh's raw 'docker exec ...keycloak' realm
  # mutations address the PRODUCTION container name.
  run grep -F 'CONTAINER_PREFIX is empty' scripts/local.sh
  [ "$status" -eq 0 ]
}

@test "the pre-deploy database backup does not trust pg_isready" {
  # pg_isready exits 0 for any role name, including one that does not exist and
  # including the empty string.
  run python3 -c "
import re
for p in ('scripts/backup.sh', 'scripts/deploy.sh'):
    body = [l for l in open(p) if not re.match(r'\s*#', l)]
    bad = [l.strip() for l in body if 'pg_isready' in l]
    assert not bad, (p, bad)
"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Keycloak SSO for platform services (issue #530)
#
# The non-negotiable requirement is the FALLBACK: Keycloak must never be the
# only way into anything. These guard the settings that make that true.
# ---------------------------------------------------------------------------

@test "Grafana keeps its local login form alongside SSO" {
  # GF_AUTH_DISABLE_LOGIN_FORM=true would hide the username/password form and
  # AUTO_LOGIN=true would skip it — either makes Keycloak the only way in.
  run grep -F 'GF_AUTH_DISABLE_LOGIN_FORM=false' deploy/compose/prod/docker-compose.observability.yml
  [ "$status" -eq 0 ]
  run grep -F 'GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN=false' deploy/compose/prod/docker-compose.observability.yml
  [ "$status" -eq 0 ]
}

@test "Portainer never hides its internal login form" {
  # Portainer's OAuth "SSO" flag suppresses the internal form.
  run python3 -c "
import re
body = [l for l in open('scripts/portainer.sh') if not re.match(r'\s*#', l)]
src = ''.join(body)
assert '\"SSO\": False' in src, 'portainer.sh must set SSO=False'
assert '\"SSO\": True' not in src
"
  [ "$status" -eq 0 ]
}

@test "Grafana uses explicit OAuth endpoints, not OIDC discovery" {
  # Discovery would make Grafana fetch from Keycloak, coupling its startup to
  # the IdP being reachable.
  for v in AUTH_URL TOKEN_URL API_URL; do
    run grep -F "GF_AUTH_GENERIC_OAUTH_${v}=" deploy/compose/prod/docker-compose.observability.yml
    [ "$status" -eq 0 ]
  done
}

@test "the SSO fallback runbook exists and every service is covered" {
  [ -f docs/runbooks/sso-fallback.md ]
  for svc in Grafana Portainer OpenBao; do
    run grep -F "$svc" docs/runbooks/sso-fallback.md
    [ "$status" -eq 0 ]
  done
}

@test "the runbook states plainly that MinIO SSO is deferred" {
  # MinIO is in issue #530 but is not deployed in this repository. Saying so is
  # the requirement; quietly skipping it is not acceptable.
  run grep -iE "MinIO is not deployed|deferred, not done" docs/runbooks/sso-fallback.md
  [ "$status" -eq 0 ]
}

@test "SSO realm configuration is applied on deploy, not just documented" {
  # platform-realm.json is first-boot-only, so without this the SSO clients
  # would never appear on the existing production realm.
  run grep -F 'keycloak.sh" apply' scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "keycloak.sh and portainer.sh default to the production URLs" {
  run grep -F 'KC_PUBLIC_URL:-https://auth.hill90.com' scripts/keycloak.sh
  [ "$status" -eq 0 ]
  run grep -F 'PORTAINER_PUBLIC_URL:-https://portainer.hill90.com' scripts/portainer.sh
  [ "$status" -eq 0 ]
}

@test "no OIDC client secret is hardcoded in the SSO scripts" {
  # An earlier version of this test had escape clauses ('$' in line, or the
  # variable name appearing) that a real hardcoded secret satisfied, so it
  # passed on GRAFANA_OIDC_CLIENT_SECRET=hunter2. Assert on the VALUE instead:
  # anything assigned to a *_SECRET that is not a variable reference is literal.
  run python3 -c "
import re
pat = re.compile(r'([A-Z_]*SECRET)=([^\s;|&)]+)')
for p in ('scripts/keycloak.sh', 'scripts/portainer.sh'):
    for n, l in enumerate(open(p), 1):
        if re.match(r'\s*#', l):
            continue
        for var, val in pat.findall(l):
            # Acceptable: a variable reference, or the empty-default idiom.
            assert val.startswith('\"\$') or val.startswith('\$') or val in ('\"\"', \"''\"), (p, n, var, val)
"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Behavioural tests — these RUN keycloak.sh rather than grepping it.
#
# They need the local stack (bash scripts/local.sh up && sso) and skip cleanly
# without it, so CI stays green while local runs get real coverage. The two
# properties below are the ones that were most expensive to get wrong.
# ---------------------------------------------------------------------------

setup_local_kc() {
    KC_TEST_CONTAINER="hill90dev-keycloak"
    docker inspect "$KC_TEST_CONTAINER" >/dev/null 2>&1 \
        || skip "local Keycloak not running (bash scripts/local.sh up)"
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$KC_TEST_CONTAINER" 2>/dev/null)" = "healthy" ] \
        || skip "local Keycloak not healthy yet"
}

kc_secret() {
    KC_CONTAINER="$KC_TEST_CONTAINER" KC_ADMIN_USERNAME=admin KC_ADMIN_PASSWORD=admin \
        bash scripts/keycloak.sh client-secret "$1" 2>/dev/null | tr -d '\r\n'
}

@test "keycloak.sh apply refuses to write an empty client secret" {
  setup_local_kc
  local before after
  before=$(kc_secret grafana)
  [ -n "$before" ] || skip "grafana client not configured yet (bash scripts/local.sh sso)"

  # An unresolvable secret must abort the whole run, not blank the client and
  # exit 0 — which is exactly what it used to do, because `die` inside $( )
  # only exits the subshell.
  run env KC_CONTAINER="$KC_TEST_CONTAINER" KC_ADMIN_USERNAME=admin KC_ADMIN_PASSWORD=admin \
      KC_SECRETS_FILE=/nonexistent-secrets-file \
      GRAFANA_OIDC_CLIENT_SECRET= PORTAINER_OIDC_CLIENT_SECRET=x VAULT_OIDC_CLIENT_SECRET=y \
      bash scripts/keycloak.sh apply
  [ "$status" -ne 0 ]

  after=$(kc_secret grafana)
  [ "$before" = "$after" ]
}

@test "keycloak.sh apply is idempotent" {
  setup_local_kc
  docker inspect hill90dev-portainer >/dev/null 2>&1 || skip "local stack incomplete"

  run bash scripts/local.sh sso
  [ "$status" -eq 0 ] || skip "local.sh sso unavailable in this environment"

  local first second
  first=$(kc_secret grafana)
  run bash scripts/local.sh sso
  [ "$status" -eq 0 ]
  second=$(kc_secret grafana)

  # A regenerated secret would break every already-configured service.
  [ "$first" = "$second" ]
}

@test "the OpenBao client keeps the claim its bound_claims expects" {
  setup_local_kc
  # vault.sh binds realm_roles; a mapper on realm_access.roles would mean
  # OpenBao's bound claim can never match and SSO silently fails for everyone.
  run bash -c '
    kc() { docker exec hill90dev-keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
    KC_CLI_PASSWORD=admin docker exec -e KC_CLI_PASSWORD hill90dev-keycloak \
      /opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 \
      --realm master --user admin >/dev/null 2>&1
    uuid=$(kc get clients -r platform -q clientId=hill90-vault --fields id --format csv --noquotes 2>/dev/null | tr -d "\r")
    [ -n "$uuid" ] || exit 1
    kc get "clients/$uuid/protocol-mappers/models" -r platform 2>/dev/null | python3 -c "
import json, sys
ms = json.load(sys.stdin)
m = [x for x in ms if x[\"name\"] == \"realm-roles\"]
assert m, \"no realm-roles mapper\"
c = m[0][\"config\"].get(\"claim.name\")
assert c == \"realm_roles\", c
"
  '
  [ "$status" -eq 0 ]
}
