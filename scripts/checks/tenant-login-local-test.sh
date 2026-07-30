#!/usr/bin/env bash
# Complete a REAL authorization-code login against the LOCAL PLATFORM Keycloak as
# the tenant's client, and read the resulting token.
#
# Requires a running local platform stack; exits 0 with SKIP if there is none, so
# it is safe to run anywhere. It creates two throwaway users and deletes them.
#
# Not an example-token generator and not a form that rendered: this walks the
# actual flow — auth endpoint, login form POST, authorization code, token
# exchange — because "the form appeared" is the exact error that let a broken
# client secret sit unnoticed for a day.
#
# Two users, deliberately:
#   localdev     holds hill90-ui:admin  -> must be authorised
#   localnorole  holds no client role   -> must be REFUSED
# Without the second, this would only show authorisation is permissive.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENVF="${ENVF:-$ROOT/.env.local}"
envget() { grep -E "^$1=" "$ENVF" 2>/dev/null | tail -n1 | cut -d= -f2-; }

KC="${KC_CONTAINER:-$(envget CONTAINER_PREFIX)keycloak}"
REALM="${KC_REALM:-$(envget KC_REALM)}"; REALM="${REALM:-platform}"
BASE="${KC_PUBLIC_URL:-http://$(envget AUTH_HOST).$(envget BASE_DOMAIN):$(envget HTTP_PORT)}"
UI_REDIRECT="http://localhost:$(envget TENANT_UI_PORT)/api/auth/callback/keycloak"
SECRET=$(envget HILL90_UI_CLIENT_SECRET)
ADMIN_U=$(envget KC_ADMIN_USERNAME)
ADMIN_P=$(envget KC_ADMIN_PASSWORD)
# Generated per run, never committed. It only ever authenticates the two users this
# script creates and deletes, so a literal would be low-risk — but invariant 7 says
# secrets do not live in the tree, and a hardcoded one here was counted as the third
# credential exposure of 2026-07-30. Cheaper to generate it than to argue the
# exception. Mixed case, digit and symbol, so any password policy accepts it.
PW="Probe-$(openssl rand -hex 16)-9!"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
pass=0; fail=0
ok()  { echo -e "  ${GREEN}✓${NC} $1"; pass=$((pass+1)); }
bad() { echo -e "  ${RED}✗${NC} $1"; fail=$((fail+1)); }

docker inspect "$KC" >/dev/null 2>&1 \
  || { echo "SKIP: ${KC} is not running. Bring the local platform up first: bash scripts/local.sh up"; exit 0; }

kc() { docker exec "$KC" /opt/keycloak/bin/kcadm.sh "$@"; }
KC_CLI_PASSWORD="$ADMIN_P" docker exec -e KC_CLI_PASSWORD "$KC" \
  /opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 \
  --realm master --user "$ADMIN_U" >/dev/null 2>&1 || { echo "kcadm login failed"; exit 2; }

mkuser() {
  local u="$1"
  kc delete "users/$(kc get users -r $REALM -q "username=$u" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' | head -1)" -r $REALM >/dev/null 2>&1 || true
  # email/firstName/lastName are REQUIRED, not decoration: the realm has
  # Keycloak's default Verify Profile action, so a user missing them is diverted
  # to required-action?execution=VERIFY_PROFILE instead of completing the login.
  # That is what silently broke the first run of this script.
  kc create users -r $REALM -s "username=$u" -s enabled=true -s emailVerified=true \
     -s "email=${u}@localtest.me" -s "firstName=${u}" -s "lastName=Probe" >/dev/null 2>&1
  local id; id=$(kc get users -r $REALM -q "username=$u" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' | head -1)
  kc set-password -r $REALM --userid "$id" --new-password "$PW" >/dev/null 2>&1
  echo "$id"
}

cleanup() {
  for u in localdev localnorole; do
    local id; id=$(kc get users -r $REALM -q "username=$u" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' | head -1)
    [ -n "$id" ] && kc delete "users/$id" -r $REALM >/dev/null 2>&1
  done
  echo "  (probe users removed)"
}
trap cleanup EXIT

echo -e "${BOLD}Setting up two users${NC}"
ID_ADMIN=$(mkuser localdev)
mkuser localnorole >/dev/null
kc add-roles -r $REALM --uid "$ID_ADMIN" --cclientid hill90-ui --rolename admin >/dev/null 2>&1 \
  && ok "localdev holds hill90-ui:admin" || bad "could not assign hill90-ui:admin"
ok "localnorole holds no client role (the refusal control)"

# --------------------------------------------------------------------------
# login USER -> prints the access token, or empty on failure
# --------------------------------------------------------------------------
login() {
  local user="$1" jar; jar=$(mktemp)
  local enc_redirect auth_url
  enc_redirect=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$UI_REDIRECT")
  auth_url="${BASE}/realms/${REALM}/protocol/openid-connect/auth?client_id=hill90-ui&response_type=code&scope=openid&redirect_uri=${enc_redirect}&state=probe123"
  # 1. the login page, keeping cookies
  local form_action
  curl -s -c "$jar" -b "$jar" -L "$auth_url" -o "${jar}.html"
  # grep/sed, not an inline python regex: inside a single-quoted python -c a
  # r"...\"..." pattern is a LITERAL backslash-quote and silently never matches,
  # which is what broke the first version of this script.
  form_action=$(grep -oE 'action="[^"]+"' "${jar}.html" | head -1 \
                | sed -e 's/^action="//' -e 's/"$//' -e 's/&amp;/\&/g')
  if [ -z "$form_action" ]; then rm -f "$jar" "${jar}.html"; echo ""; return; fi
  # 2. submit credentials -> 302 carrying ?code=
  local loc
  loc=$(curl -s -c "$jar" -b "$jar" -o /dev/null -D - \
        --data-urlencode "username=${user}" --data-urlencode "password=${PW}" \
        --data-urlencode "credentialId=" "$form_action" | tr -d '\r' | awk '/^[Ll]ocation:/{print $2}' | tail -1)
  rm -f "$jar" "${jar}.html"
  local code; code=$(printf '%s' "$loc" | python3 -c '
import sys,urllib.parse
q=urllib.parse.urlparse(sys.stdin.read().strip()).query
print(urllib.parse.parse_qs(q).get("code",[""])[0])')
  [ -n "$code" ] || { echo ""; return; }
  # 3. exchange the code for tokens — the step "the form rendered" never reaches
  curl -s -X POST "${BASE}/realms/${REALM}/protocol/openid-connect/token" \
    -d grant_type=authorization_code -d "code=${code}" \
    --data-urlencode "redirect_uri=${UI_REDIRECT}" \
    -d client_id=hill90-ui --data-urlencode "client_secret=${SECRET}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null
}

claims() {
  python3 -c '
import sys, json, base64
t=sys.stdin.read().strip()
if not t: print("{}"); raise SystemExit
p=t.split(".")[1]; p+="="*(-len(p)%4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(p))))'
}

echo ""
echo -e "${BOLD}A completed login: form -> credentials -> code -> TOKEN EXCHANGE${NC}"
AT=$(login localdev)
if [ -n "$AT" ]; then
  ok "localdev completed the full code flow and received an access token"
else
  bad "localdev could not complete the flow"
fi
C=$(printf '%s' "$AT" | claims)
echo "$C" | python3 -c '
import sys, json
c=json.load(sys.stdin)
print("      iss                            =", c.get("iss"))
print("      aud                            =", c.get("aud"))
print("      azp                            =", c.get("azp"))
print("      resource_access.hill90-ui.roles=", (c.get("resource_access") or {}).get("hill90-ui",{}).get("roles"))
print("      realm_access.roles             =", (c.get("realm_access") or {}).get("roles"))
print("      realm_roles claim present      =", "realm_roles" in c)'

if [ -z "$AT" ]; then
  bad "no token, so the claim assertions below cannot pass (they must not pass vacuously)"
else
echo "$C" | python3 -c 'import sys,json; c=json.load(sys.stdin); sys.exit(0 if (c.get("resource_access") or {}).get("hill90-ui",{}).get("roles")==["admin"] else 1)' \
  && ok "the token carries resource_access.hill90-ui.roles = ['''admin''']" \
  || bad "resource_access.hill90-ui.roles is not ['''admin''']"
echo "$C" | python3 -c 'import sys,json; c=json.load(sys.stdin); a=c.get("aud"); a=a if isinstance(a,list) else [a]; sys.exit(0 if "hill90-api" in a else 1)' \
  && ok "aud includes hill90-api — the api will accept it" || bad "aud does not include hill90-api"
echo "$C" | python3 -c 'import sys,json; c=json.load(sys.stdin); r=(c.get("realm_access") or {}).get("roles") or []; sys.exit(0 if "admin" not in r else 1)' \
  && ok "realm_access.roles does NOT contain admin — realm_roles authorises nothing" \
  || bad "realm_access.roles contains admin — the privilege hole is OPEN"
echo "$C" | python3 -c 'import sys,json; sys.exit(0 if "realm_roles" not in json.load(sys.stdin) else 1)' \
  && ok "no realm_roles claim at all" || bad "a realm_roles claim is present"
fi

echo ""
echo -e "${BOLD}The refusal control: a user WITHOUT the client role${NC}"
AT2=$(login localnorole)
[ -n "$AT2" ] && ok "localnorole can authenticate (it should — authn is not authz)" \
              || bad "localnorole could not authenticate at all"
C2=$(printf '%s' "$AT2" | claims)
echo "$C2" | python3 -c '
import sys, json
c=json.load(sys.stdin)
print("      resource_access.hill90-ui      =", (c.get("resource_access") or {}).get("hill90-ui"))
print("      realm_access.roles             =", (c.get("realm_access") or {}).get("roles"))'
if [ -z "$AT2" ]; then
  bad "no token for localnorole, so the refusal assertion cannot pass vacuously"
else
echo "$C2" | python3 -c '
import sys, json
c=json.load(sys.stdin)
roles=(c.get("resource_access") or {}).get("hill90-ui",{}).get("roles") or []
sys.exit(0 if "admin" not in roles and "user" not in roles else 1)' \
  && ok "it carries NO hill90-ui role — every app permission check returns empty, so it is denied" \
  || bad "it carries a hill90-ui role it was never granted"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All ${pass} assertions passed against the local platform Keycloak.${NC}"; exit 0
fi
echo -e "${RED}${BOLD}${fail} failed, ${pass} passed.${NC}"; exit 1
