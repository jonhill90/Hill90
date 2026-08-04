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

@test "the platform realm's client list is exactly the deliberate allowlist" {
  # SUPERSEDED ASSERTION, recorded rather than deleted quietly.
  #
  # This test used to assert the OPPOSITE: that hill90-ui and hill90-api must NOT
  # appear here, "because the extracted application is one tenant among several
  # and brings its own realm". That was the realm-per-consumer shape in
  # docs/decisions/platform-primitives.md, and it was retracted — the settled
  # decision is ONE Keycloak and ONE realm, the existing `platform`, with the
  # tenant's clients inside it. The live realm has had both clients since
  # 2026-07-30, so the old assertion contradicted production.
  #
  # The guard is kept with teeth rather than dropped: the client list is an
  # ALLOWLIST, so a new client cannot accumulate here without someone editing this
  # line and thinking about it. That is what the original test was really for.
  #
  # grafana and portainer are deliberately absent — scripts/keycloak.sh creates
  # those at deploy time, they were never in this file.
  run python3 -c "
import json
r = json.load(open('platform/auth/keycloak/platform-realm.json'))
ids = sorted(c['clientId'] for c in r.get('clients', []))
expected = sorted(['hill90-vault', 'hill90-ui', 'hill90-api'])
assert ids == expected, f'unexpected client list: {ids} != {expected}'
"
  [ "$status" -eq 0 ]
}

@test "the tenant's clients carry no realm-role mapper" {
  # The reason the tenant's clients are allowed in this realm at all is that they
  # use CLIENT roles. This realm grants Grafana Admin and OpenBao off the REALM
  # role 'admin', so a realm-role mapper on a tenant client would hand an
  # application admin infrastructure administration.
  #
  # Asserted here as well as in scripts/checks/check_realm_tenant_clients.py
  # because this is the file that reviews the realm's separation properties.
  run python3 -c "
import json
r = json.load(open('platform/auth/keycloak/platform-realm.json'))
bad = []
for c in r.get('clients', []):
    if c['clientId'] not in ('hill90-ui', 'hill90-api'):
        continue
    for m in c.get('protocolMappers', []) or []:
        if m.get('protocolMapper') in ('oidc-usermodel-realm-role-mapper',
                                       'oidc-usermodel-role-mapper'):
            bad.append((c['clientId'], m.get('name')))
assert not bad, f'realm-role mapper on a tenant client: {bad}'
"
  [ "$status" -eq 0 ]
}

@test "scripts/keycloak.sh's hardcoded hill90-ui scope lists include 'basic', both of them" {
  # #704: platform-realm.json's hill90-ui was missing 'basic', so a realm
  # IMPORT (a VPS rebuild) would produce a client that issues tokens with no
  # 'sub' — hill90-app reads user.sub at 158 call sites and hill90-app#306
  # refuses a token without one.
  #
  # scripts/keycloak.sh tenant_clients has the SAME list twice, hardcoded in a
  # python payload: once when CREATING hill90-ui, once when RECONCILING it.
  # The reconcile branch runs `kcadm update` against a client that may
  # already be correct — so if this list omitted 'basic', running this
  # command would have STRIPPED it from a working production client, not
  # merely failed to grant it to a new one. Both occurrences must carry it,
  # and both must move with platform-realm.json's own list or the two paths
  # that can create hill90-ui (import vs kcadm) disagree again.
  count=$(grep -c '"defaultClientScopes": \[.*"basic".*\]' scripts/keycloak.sh)
  [ "$count" -eq 2 ]
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

@test "the runbook states plainly that MinIO has no SSO" {
  # This started life asserting MinIO was DEFERRED. MinIO is now deployed, so
  # the claim to guard changed: it must say plainly that there is no SSO login,
  # because MinIO removed the console from the AGPL build in May 2025. The
  # failure mode is someone reading "OIDC configured" as "SSO works".
  # ONE exact phrase, no alternation. An earlier version offered several
  # acceptable spellings, so deleting the disclaimer still passed via a
  # different clause — the same tautology this suite has been bitten by before.
  run grep -F "MinIO has no SSO login." docs/runbooks/sso-fallback.md
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

# ---------------------------------------------------------------------------
# Object store (MinIO) — restored as a platform service
#
# The load-bearing claim is a NEGATIVE one: this is not SSO. MinIO removed the
# console from the AGPL build in May 2025, so the console is root-credential
# only. These guard against that being quietly overstated later.
# ---------------------------------------------------------------------------

@test "MinIO is pinned to a specific release, not a floating tag" {
  # A floating tag would silently change the console behaviour the docs describe.
  run grep -E 'image: minio/minio:RELEASE\.[0-9]' deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 0 ]
  run grep -E 'image: minio/minio:(latest|edge)' deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -ne 0 ]
}

@test "MinIO is not pinned to a pre-console-removal release" {
  # Pinning RELEASE.2025-04-22 or earlier would restore the SSO button at the
  # cost of freezing an internet-facing service on an unpatched build. That was
  # considered and rejected; this stops it being done by accident.
  # Asserting a MINIMUM, not blacklisting four months of 2025: the first
  # version of this test used RELEASE\.2025-0[1-4] and happily passed a 2024
  # pin, which is even older and even more unpatched.
  run python3 -c "
import re
src = open('deploy/compose/prod/docker-compose.minio.yml').read()
m = re.search(r'image: minio/minio:RELEASE\.(\d{4})-(\d{2})', src)
assert m, 'no pinned RELEASE tag found'
year, month = int(m.group(1)), int(m.group(2))
# The console was removed in May 2025; anything earlier keeps the SSO button
# only by freezing on an unpatched build.
assert (year, month) >= (2025, 5), (year, month)
"
  [ "$status" -eq 0 ]
}

@test "the S3 API is not routed externally" {
  # Only the console gets a router. Publishing the API would mean a hostname
  # with no DNS record and a second certificate that has never issued.
  # Assert on the SHAPE, not on one router name: the first version banned the
  # literal string 'minio-api', so a router called anything else pointing at
  # port 9000 sailed through.
  run python3 -c "
import re
body = [l for l in open('deploy/compose/prod/docker-compose.minio.yml') if not re.match(r'\s*#', l)]
src = ''.join(body)
routers = set(re.findall(r'traefik\.http\.routers\.([A-Za-z0-9_-]+)\.', src))
assert routers == {'minio-console'}, routers
ports = set(re.findall(r'loadbalancer\.server\.port=(\d+)', src))
assert ports == {'9001'}, ports
"
  [ "$status" -eq 0 ]
}

@test "MinIO's certificate resolver is inherited, not hardcoded" {
  # storage.hill90.com has never issued under the current ACME path (#538), and
  # DNS-01 is mid-migration to Cloudflare (#535). Hardcoding a resolver here
  # would pin the wrong provider.
  run grep -F 'ADMIN_CERT_RESOLVER' deploy/compose/prod/docker-compose.minio.yml
  [ "$status" -eq 0 ]
  run python3 -c "
import re
body = [l for l in open('deploy/compose/prod/docker-compose.minio.yml') if not re.match(r'\s*#', l)]
for l in body:
    if 'certresolver=' in l:
        assert 'ADMIN_CERT_RESOLVER' in l, l
"
  [ "$status" -eq 0 ]
}

@test "the docs do not claim MinIO has SSO" {
  # The single most likely thing to be overstated.
  # One exact phrase per file, no alternation — three acceptable spellings meant
  # deleting two of them still passed on the third.
  run grep -F "This is not SSO and must not be described as SSO." docs/decisions/object-store.md
  [ "$status" -eq 0 ]
  run grep -F "The console has no SSO button" docs/runbooks/object-store.md
  [ "$status" -eq 0 ]
}

@test "the MinIO admin policy separates s3 and admin actions" {
  # MinIO rejects a statement mixing them with
  # "unsupported admin action 's3:*'", which fails policy creation outright.
  run python3 -c "
import json, re, subprocess
src = open('scripts/minio.sh').read()
m = re.search(r\"admin\)\s+echo '([^']+)'\", src)
assert m, 'admin policy not found'
doc = json.loads(m.group(1))
stmts = doc['Statement']
for s in stmts:
    acts = s['Action']
    assert not (any(a.startswith('s3:') for a in acts) and any(a.startswith('admin:') for a in acts)), acts
"
  [ "$status" -eq 0 ]
}

@test "MinIO policies are provisioned on deploy, not just documented" {
  # Without them every federated login is rejected with "no policy found".
  # Comment lines excluded: prefixing the call with # left this passing.
  run python3 -c "
import re
body = [l for l in open('scripts/deploy.sh') if not re.match(r'\s*#', l)]
assert any('minio.sh\" apply' in l for l in body), 'minio.sh apply is not invoked'
"
  [ "$status" -eq 0 ]
}

@test "the object store decision record flags the maintenance question" {
  # MinIO community's latest release is ~10 months old; the alternatives belong
  # in their own decision, but the question must be on the record.
  run grep -iE "Garage|SeaweedFS" docs/decisions/object-store.md
  [ "$status" -eq 0 ]
}
