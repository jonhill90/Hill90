#!/usr/bin/env bash
# Drive a REAL Grafana SSO login and assert the ORG ROLE it yields.
#
#   bash scripts/checks/grafana-role-login-test.sh <username> <expected-role>
#   bash scripts/checks/grafana-role-login-test.sh testuser01 Viewer
#
# WHY A LOGIN AND NOT A CONFIG READ
# =================================
# Reading GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH is what let this drift for two
# days. Stage 2a repointed the ADMIN arm of that expression to platform-admin and
# left the EDITOR arm naming the zero-holder realm role `editor` (#666). The env
# var looked repointed. It was half repointed.
#
# And the failure is silent by construction: role_attribute_strict defaults to
# false, so an arm that matches nothing does not error — the JMESPath falls
# through to 'Viewer'. There is no log line, no failed login, no 500. The only
# thing that distinguishes a working arm from a dead one is what a real user
# actually gets, so that is what this measures.
#
# WHAT IT DOES — the full authorization-code flow, headless:
#   1. GET /login/generic_oauth at Grafana, keep its cookie, follow to Keycloak
#   2. POST the credentials to the login form
#   3. hand the code back to Grafana's callback, keep the session cookie
#   4. GET /api/user/orgs as that session and read the role Grafana assigned
#
# SIDE EFFECT, stated because it is real: this creates a genuine Grafana session
# and a LOGIN event for the user in realm `platform`. That is the cost of proof.
#
# THE PASSWORD never appears in argv. curl's --data-urlencode would place it
# there — `ps -Ao args` is world-readable — so it goes through a 0600 file inside
# a mktemp directory that is removed on exit, read back by curl's `name@file`
# form. Brief, mode-protected disk beats world-readable argv. It is never printed.
#
# Exit: 0 the login yielded the expected role | 1 otherwise
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

USERNAME="${1:-}"
EXPECTED="${2:-}"
[ -n "$USERNAME" ] && [ -n "$EXPECTED" ] || {
    echo "usage: $0 <username> <expected-grafana-role>   e.g. testuser01 Editor"
    exit 2
}

GRAFANA_URL="${GRAFANA_PUBLIC_URL:-https://grafana.hill90.com}"
KC_URL="${KC_PUBLIC_URL:-https://auth.hill90.com}"
KC_REALM="${KC_REALM:-platform}"
SECRETS_FILE="${SECRETS_FILE:-$PROJECT_ROOT/infra/secrets/prod.enc.env}"
# Key defaults to the one matching the username, so the caller names an account
# rather than a secret. testuser01 -> TEST_USER_PASSWORD, jon -> JON_KC_PASSWORD.
case "$USERNAME" in
    testuser01) DEFAULT_KEY=TEST_USER_PASSWORD ;;
    jon)        DEFAULT_KEY=JON_KC_PASSWORD ;;
    hill90admin) DEFAULT_KEY=HILL90ADMIN_KC_PASSWORD ;;
    *)          DEFAULT_KEY="" ;;
esac
PASSWORD_KEY="${PASSWORD_KEY:-$DEFAULT_KEY}"
[ -n "$PASSWORD_KEY" ] || { echo "no password key known for ${USERNAME}; set PASSWORD_KEY"; exit 2; }

GREEN=$'\033[32m'; RED=$'\033[31m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
ok()  { printf '  %sok%s   %s\n' "$GREEN" "$OFF" "$1"; }
bad() { printf '  %sFAIL%s %s\n' "$RED" "$OFF" "$1"; }

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

printf '%sGrafana SSO login — real authorization-code flow%s\n' "$BOLD" "$OFF"
echo "  user: ${USERNAME}   expected Grafana role: ${EXPECTED}   realm: ${KC_REALM}"
echo

# Default the age key the way the other checks do, so the script works from a
# workstation and on the box without the caller remembering.
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$PROJECT_ROOT/infra/secrets/keys/age-prod.key}"
[ -f "$SOPS_AGE_KEY_FILE" ] || export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt

PASSWORD="$(sops -d --extract "[\"${PASSWORD_KEY}\"]" "$SECRETS_FILE" 2>/dev/null)"
[ -n "$PASSWORD" ] || { bad "${PASSWORD_KEY} not found in ${SECRETS_FILE}"; exit 1; }
umask 077
printf '%s' "$PASSWORD" > "$TMP/pw"
unset PASSWORD

J="$TMP/jar"

# --- 1. start the flow at Grafana -------------------------------------------
# Grafana mints an oauth state cookie here; without carrying it the callback is
# rejected as a CSRF failure, which reads like a broken IdP.
AUTH_URL="$(curl -sS -c "$J" -o /dev/null -w '%{redirect_url}' "${GRAFANA_URL}/login/generic_oauth")"
case "$AUTH_URL" in
    "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/auth"*)
        ok "Grafana redirected to ${KC_URL}, realm ${KC_REALM}" ;;
    "")  bad "Grafana did not redirect — is generic_oauth enabled?"; exit 1 ;;
    *)   bad "unexpected authorize URL: ${AUTH_URL%%\?*}"; exit 1 ;;
esac

# --- 2. the Keycloak login form ---------------------------------------------
FORM="$(curl -sS -c "$TMP/kc" "$AUTH_URL")" || { bad "could not reach Keycloak"; exit 1; }
ACTION="$(printf '%s' "$FORM" | python3 -c '
import sys, re, html
m = re.search(r"<form[^>]*id=\"kc-form-login\"[^>]*action=\"([^\"]+)\"", sys.stdin.read())
print(html.unescape(m.group(1)) if m else "")')"
if [ -z "$ACTION" ]; then
    bad "no Keycloak login form in the response"
    # A pending required action lands elsewhere and looks like bad credentials.
    printf '%s' "$FORM" | grep -o 'required-action[^"]*' | head -2 | sed 's/^/       /'
    exit 1
fi
ok "Keycloak served a login form"

# --- 3. credentials -> authorization code ------------------------------------
LOC="$(curl -sS -b "$TMP/kc" -c "$TMP/kc" -D - -o /dev/null \
        --data-urlencode "username=${USERNAME}" \
        --data-urlencode "password@${TMP}/pw" \
        --data-urlencode "credentialId=" \
        "$ACTION" | grep -i '^location:' | tail -1 | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')"
rm -f "$TMP/pw"

case "$LOC" in
    "${GRAFANA_URL}"*) ok "Keycloak issued an authorization code for ${USERNAME}" ;;
    "") bad "no redirect after the credential POST — the login did not complete"; exit 1 ;;
    *)  bad "unexpected redirect target: ${LOC%%\?*}"; exit 1 ;;
esac

# --- 4. redeem it at Grafana, then ask what role we got ----------------------
CODE="$(curl -sS -b "$J" -c "$J" -o /dev/null -w '%{http_code}' "$LOC")"
ROLE_JSON="$(curl -sS -b "$J" -c "$J" "${GRAFANA_URL}/api/user/orgs")"
ROLE="$(printf '%s' "$ROLE_JSON" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d[0]["role"] if isinstance(d, list) and d else "")
except Exception:
    print("")')"

if [ -z "$ROLE" ]; then
    bad "no org role returned — the session did not establish (callback HTTP ${CODE})"
    printf '%s' "$ROLE_JSON" | head -c 200 | sed 's/^/       /'
    echo
    exit 1
fi
ok "session established; Grafana assigned org role: ${ROLE}"

echo
if [ "$ROLE" = "$EXPECTED" ]; then
    printf '%s%s logged in and received %s, as expected%s\n' "$GREEN" "$USERNAME" "$ROLE" "$OFF"
    exit 0
fi
printf '%sexpected %s, got %s.%s A wrong role here is not a login failure —\n' "$RED" "$EXPECTED" "$ROLE" "$OFF"
printf 'role_attribute_strict is false, so an arm that matches nothing falls through\n'
printf 'to Viewer silently. Check that the realm role in the expression has holders.\n'
exit 1
