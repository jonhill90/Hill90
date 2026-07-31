#!/usr/bin/env bash
# Prove platform-realm.json actually SERVES the tenant, by importing it into a
# real Keycloak and generating the access token a user would receive.
#
# check_realm_tenant_clients.py asserts the FILE is shaped correctly. That is not
# the same as asserting Keycloak emits the claim the app reads, which depends on
# built-in client scopes this repo does not own. So this asks Keycloak itself:
# import the realm, assign a client role, and read the resulting token.
#
# It builds and destroys its own throwaway Keycloak. It never touches a running
# stack, and it never touches the VPS.
#
# Two things bit this test before the realm was ever in question, both recorded
# here so the next person does not rediscover them:
#   - the Keycloak 26 image is UBI-micro and ships NO curl, so an in-container
#     HTTP probe fails while the server is perfectly healthy;
#   - the realm ships sslRequired=external, correct for production, so plain HTTP
#     returns 403 "HTTPS required" until it is relaxed — which is exactly what
#     scripts/local.sh does to the running realm.
#
# Usage: bash scripts/checks/realm-tenant-serves-test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KC="h90realmtest-kc"
IMG="quay.io/keycloak/keycloak:26.4.0"
ADMIN="admin"
# Disposable, for a container that is destroyed at the end of this script.
ADMIN_PW=throwaway-not-a-real-credential

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
pass=0; fail=0

# ---------------------------------------------------------------------------
# Phase timing.
#
# Added because a run of the pytest suite once took 340s against a 66s median and
# PASSED, and nothing in the output said which part was slow. Timing per phase makes
# the next outlier attributable instead of a mystery.
#
# The pull is timed SEPARATELY and deliberately. Left inside `docker run -d`, a cold
# image pull is indistinguishable from a slow server boot — and on a fresh CI runner
# the pull is most of the wall clock. So a cold run and a warm run must read
# differently here; that difference is the measurement, not noise to smooth away.
#
# Whole seconds via `date +%s`: portable to the bash 3.2 that ships with macOS,
# where EPOCHREALTIME does not exist. Every phase here is seconds-scale, and the
# readiness phase additionally reports attempts used, which is finer than a clock.
# ---------------------------------------------------------------------------
IMG_STATE="unknown"; T_PULL=0; T_START=0; T_READY=0; T_ASSERT=0; READY_TRIES=0
READY_CAP_TRIES=60; READY_CAP_SLEEP=2
now() { date +%s; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; pass=$((pass+1)); }
bad()  { echo -e "  ${RED}✗${NC} $1"; fail=$((fail+1)); }

cleanup() { docker rm -f "$KC" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo -e "${BOLD}Importing platform-realm.json into a real Keycloak${NC}"

# PHASE: image. Pull explicitly so its cost is visible rather than folded into start.
if docker image inspect "$IMG" >/dev/null 2>&1; then
    IMG_STATE="cached"
    echo "  image: cached locally (no pull)"
else
    IMG_STATE="pulled"
    echo "  image: not present locally — pulling ${IMG}"
    _t0=$(now); docker pull -q "$IMG" >/dev/null 2>&1; T_PULL=$(( $(now) - _t0 ))
    echo "  image: pulled in ${T_PULL}s"
fi

# PHASE: start.
_t0=$(now)
docker run -d --name "$KC" -p 18099:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME="$ADMIN" \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PW" \
  -e KC_HTTP_ENABLED=true \
  -e HILL90_UI_CLIENT_SECRET=local-tenant-ui-secret-0123456789 \
  -e HILL90_UI_REDIRECT_URI=http://localhost:13000/api/auth/callback/keycloak \
  -e HILL90_UI_WEB_ORIGIN=http://localhost:13000 \
  -e VAULT_OIDC_CLIENT_SECRET=throwaway-vault-secret \
  -e GRAFANA_OIDC_CLIENT_SECRET=throwaway-grafana-secret \
  -e PORTAINER_OIDC_CLIENT_SECRET=throwaway-portainer-secret \
  -v "$ROOT/platform/auth/keycloak/platform-realm.json:/opt/keycloak/data/import/platform-realm.json:ro" \
  "$IMG" start-dev --import-realm >/dev/null

echo "  waiting for Keycloak..."
# Readiness via kcadm, not curl: the Keycloak 26 image is UBI-micro and ships no
# curl, so an in-container HTTP probe fails even when the server is fine. And the
# realm ships sslRequired=external (correct for production), so plain HTTP from
# the host returns 403 "HTTPS required" until it is relaxed — scripts/local.sh
# does exactly that on the running realm. Both of those bit this verification
# before the realm itself was ever in question.
# argv-ok: ADMIN_PW is the literal throwaway on line 29, in a container this
# script creates and destroys. No real credential exists in this process tree.
ready() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh config credentials \
            --server http://127.0.0.1:8080 --realm master \
            --user "$ADMIN" --password "$ADMIN_PW" >/dev/null 2>&1; }
T_START=$(( $(now) - _t0 ))
echo "  start: container running after ${T_START}s"

# PHASE: ready. The cap is UNCHANGED at 60 attempts x 2s = 120s. Attempts used is
# reported so headroom is a measured number rather than an estimate — and so a run
# that nearly exhausted the budget is visible even though it passed.
_t0=$(now)
for _ in $(seq 1 "$READY_CAP_TRIES"); do
  READY_TRIES=$((READY_TRIES + 1))
  ready && break
  sleep "$READY_CAP_SLEEP"
done
T_READY=$(( $(now) - _t0 ))
if ! ready; then
  echo -e "${RED}Keycloak never came up after ${T_READY}s (${READY_TRIES}/${READY_CAP_TRIES} attempts, cap $((READY_CAP_TRIES * READY_CAP_SLEEP))s). Import log:${NC}"
  docker logs "$KC" 2>&1 | grep -iE "error|warn|import|realm" | tail -25
  exit 2
fi
echo "  ready: after ${T_READY}s (${READY_TRIES}/${READY_CAP_TRIES} attempts, cap $((READY_CAP_TRIES * READY_CAP_SLEEP))s)"
ok "realm 'platform' imported; kcadm authenticated"
_t_assert0=$(now)

# The same delta local.sh applies, so HTTP discovery is reachable here too.
docker exec "$KC" /opt/keycloak/bin/kcadm.sh update realms/platform -s sslRequired=NONE >/dev/null 2>&1
if curl -sf "http://localhost:18099/realms/platform/.well-known/openid-configuration" >/dev/null 2>&1; then
  ok "OIDC discovery served over HTTP after relaxing sslRequired (as local.sh does)"
else
  bad "OIDC discovery still not served over HTTP"
fi

kc() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh "$@" 2>&1; }
# argv-ok: same throwaway credential and throwaway container as above.
kc config credentials --server http://localhost:8080 --realm master \
   --user "$ADMIN" --password "$ADMIN_PW" >/dev/null 2>&1 \
   || { echo "kcadm login failed"; exit 2; }

# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}The clients a tenant consumes${NC}"
CLIENTS=$(kc get clients -r platform --fields clientId 2>/dev/null | tr -d ' \n')
for c in hill90-ui hill90-api hill90-vault; do
  echo "$CLIENTS" | grep -q "\"$c\"" && ok "client $c present" || bad "client $c MISSING"
done

get_field() { kc get "clients?clientId=$1" -r platform 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d: print('MISSING'); raise SystemExit
v=d[0]
for k in '$2'.split('.'):
    v = v.get(k) if isinstance(v,dict) else v
print(json.dumps(v))
" 2>/dev/null; }

# These must be PRODUCTION's values verbatim. Local gets its callback appended to
# the running client by local.sh, which is why the file can mirror prod exactly.
RU=$(get_field hill90-ui redirectUris)
[ "$RU" = '["https://hill90.com/api/auth/callback/keycloak"]' ] \
  && ok "redirectUris mirror production exactly: $RU" \
  || bad "redirectUris are not production's: $RU"
WO=$(get_field hill90-ui webOrigins)
[ "$WO" = '["https://hill90.com"]' ] \
  && ok "webOrigins mirror production exactly: $WO" \
  || bad "webOrigins are not production's: $WO"

[ "$(get_field hill90-ui publicClient)" = "false" ] && ok "hill90-ui is confidential" || bad "hill90-ui is not confidential"
[ "$(get_field hill90-api bearerOnly)" = "true" ]   && ok "hill90-api is bearer-only" || bad "hill90-api is not bearer-only"

# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}Client roles, and the platform's own client untouched${NC}"
UI_ID=$(kc get "clients?clientId=hill90-ui" -r platform --fields id 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
ROLES=$(kc get "clients/$UI_ID/roles" -r platform --fields name 2>/dev/null | tr -d ' \n')
for r in user admin; do
  echo "$ROLES" | grep -q "\"$r\"" && ok "client role hill90-ui:$r exists" || bad "client role hill90-ui:$r MISSING"
done
VAULT_MAP=$(kc get "clients?clientId=hill90-vault" -r platform 2>/dev/null | python3 -c "
import sys,json
c=json.load(sys.stdin)[0]
ms=[(m['name'],(m.get('config') or {}).get('claim.name')) for m in c.get('protocolMappers',[])]
print(ms)
" 2>/dev/null)
echo "$VAULT_MAP" | grep -q "realm_roles" \
  && ok "hill90-vault kept its realm_roles mapper — $VAULT_MAP" \
  || bad "hill90-vault lost its realm_roles mapper — $VAULT_MAP"

# ---------------------------------------------------------------------------
# The decisive test: what claims does a user actually GET?
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}The token a user would actually receive${NC}"
kc create users -r platform -s username=localdev -s enabled=true >/dev/null 2>&1
UID_=$(kc get "users?username=localdev&exact=true" -r platform --fields id 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
kc add-roles -r platform --uid "$UID_" --cclientid hill90-ui --rolename admin >/dev/null 2>&1 \
  && ok "assigned hill90-ui:admin to a test user" \
  || bad "could not assign the client role"

TOKEN_JSON=$(kc get "clients/$UI_ID/evaluate-scopes/generate-example-access-token?userId=${UID_}&scope=" -r platform 2>/dev/null)
echo "$TOKEN_JSON" | python3 -c "
import sys, json
raw = sys.stdin.read()
try:
    t = json.loads(raw)
except Exception:
    print('COULD NOT PARSE:', raw[:400]); raise SystemExit(1)
ra = (t.get('resource_access') or {}).get('hill90-ui', {}).get('roles')
aud = t.get('aud')
realm = (t.get('realm_access') or {}).get('roles')
print('resource_access.hill90-ui.roles =', ra)
print('aud                            =', aud)
print('realm_access.roles             =', realm)
print('has realm_roles claim          =', 'realm_roles' in t)
" > /tmp/h90-token-claims.txt 2>&1
cat /tmp/h90-token-claims.txt | sed 's/^/      /'

CLAIMS=$(cat /tmp/h90-token-claims.txt)
echo "$CLAIMS" | grep -q "resource_access.hill90-ui.roles = \['admin'\]" \
  && ok "the claim the app reads is populated: resource_access.hill90-ui.roles = ['admin']" \
  || bad "resource_access.hill90-ui.roles is NOT what the app expects"
echo "$CLAIMS" | grep -qE "aud .*hill90-api" \
  && ok "audience includes hill90-api, so the api will accept the UI's token" \
  || bad "audience does NOT include hill90-api — the api would reject these tokens"
echo "$CLAIMS" | grep -q "has realm_roles claim          = False" \
  && ok "no realm_roles claim on the tenant token — the privilege hole stays closed" \
  || bad "a realm_roles claim is present on the tenant token"

# ---------------------------------------------------------------------------
# The local delta local.sh applies. New code, so prove it rather than trust it:
# it must ADD the local callback and origin while KEEPING production's.
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}The local delta (same kcadm calls scripts/local.sh makes)${NC}"
UI_LOCAL="http://localhost:13000"
UI_URIS=$(python3 -c '
import json, sys
print(json.dumps(["https://hill90.com/api/auth/callback/keycloak",
                  sys.argv[1].rstrip("/") + "/api/auth/callback/keycloak"]))' "$UI_LOCAL")
UI_ORIGINS=$(python3 -c '
import json, sys
print(json.dumps(["https://hill90.com", sys.argv[1].rstrip("/")]))' "$UI_LOCAL")
CID=$(docker exec "$KC" /opt/keycloak/bin/kcadm.sh get clients -r platform \
        -q clientId=hill90-ui --fields id --format csv --noquotes 2>/dev/null | tr -d '\r')
if [ -n "$CID" ] && docker exec "$KC" /opt/keycloak/bin/kcadm.sh update "clients/${CID}" \
     -r platform -s "redirectUris=${UI_URIS}" -s "webOrigins=${UI_ORIGINS}" >/dev/null 2>&1; then
  ok "delta applied via kcadm (client id resolved by the same csv/noquotes call local.sh uses)"
else
  bad "delta failed — local.sh would warn and the tenant's local login would be rejected"
fi
RU2=$(get_field hill90-ui redirectUris)
echo "$RU2" | grep -q "localhost:13000/api/auth/callback/keycloak" \
  && ok "local callback present after the delta" || bad "local callback missing: $RU2"
echo "$RU2" | grep -q "https://hill90.com/api/auth/callback/keycloak" \
  && ok "production callback KEPT, not replaced" || bad "production callback was clobbered: $RU2"
WO2=$(get_field hill90-ui webOrigins)
echo "$WO2" | grep -q "localhost:13000" \
  && ok "local web origin present (CORS for NextAuth)" || bad "local web origin missing: $WO2"
echo "$WO2" | grep -q "https://hill90.com" \
  && ok "production web origin KEPT" || bad "production web origin was clobbered: $WO2"

T_ASSERT=$(( $(now) - _t_assert0 ))

echo ""
echo -e "${BOLD}Phase timing${NC}  (so a slow run says WHICH part was slow)"
if [ "$IMG_STATE" = "cached" ]; then
  echo "  image   cached, no pull       (a first run on this host pulls ~500MB and will differ)"
else
  echo "  image   pulled in ${T_PULL}s        (cold; a cached run will report 0s here)"
fi
echo "  start   ${T_START}s"
echo "  ready   ${T_READY}s  (${READY_TRIES}/${READY_CAP_TRIES} attempts of a $((READY_CAP_TRIES * READY_CAP_SLEEP))s cap)"
echo "  asserts ${T_ASSERT}s  (${pass} assertions, each one or more docker exec calls)"
echo "  total   $(( T_PULL + T_START + T_READY + T_ASSERT ))s accounted for"

echo ""
if [ "$fail" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All ${pass} assertions passed against a real Keycloak.${NC}"; exit 0
fi
echo -e "${RED}${BOLD}${fail} failed, ${pass} passed.${NC}"; exit 1
