#!/usr/bin/env bash
# Drive a REAL OpenBao OIDC login for jon and assert the policy it yields.
#
# WHY A LOGIN AND NOT A CONFIG READ
# =================================
# `bao read auth/oidc/role/admin-sso` tells you what the role says. This estate
# has already been burned by exactly that gap: the role bound realm role `admin`,
# the config read fine, and the role had ZERO holders — so it authorised nobody
# for six days while looking correct. Only a completed flow proves the chain
# Keycloak mapper -> claim -> bound_claims -> policy actually joins up.
#
# WHAT IT DOES
# ============
# The full authorization-code flow, headless:
#   1. ask OpenBao for the authorize URL   (auth/oidc/oidc/auth_url)
#   2. GET it at Keycloak, keep the session cookie, find the login form
#   3. POST jon's credentials, capture `code` and `state` from the 302
#   4. hand them back to OpenBao's callback and read the token it issues
#
# OpenBao is addressed on its PUBLIC URL, through Traefik, because that is the
# path a human uses and because busybox wget inside the container discards error
# bodies — and the error body is the whole diagnosis here. A bound-claim mismatch
# and a broken flow both look like "no token" without it.
#
# SIDE EFFECT, stated because it is real: this creates a genuine user session and
# a LOGIN event for jon in realm `platform`. That is the cost of proving it.
#
# The password is read from SOPS into a variable and never printed, never placed
# in argv, and never written to disk. The token is never printed either — only
# the policies it carries.
#
# Usage: bash scripts/checks/vault-oidc-login-test.sh
# Exit:  0 login succeeded with the expected policy | 1 otherwise

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONTAINER="${VAULT_CONTAINER:-openbao}"
SECRETS_FILE="${VAULT_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"
VAULT_PUBLIC_URL="${VAULT_PUBLIC_URL:-https://vault.hill90.com}"
KC_URL="${KC_PUBLIC_URL:-https://auth.hill90.com}"
KC_REALM="${KC_REALM:-platform}"
ROLE="${VAULT_OIDC_ROLE:-admin-sso}"
USERNAME="${OIDC_TEST_USERNAME:-jon}"
PASSWORD_KEY="${OIDC_TEST_PASSWORD_KEY:-JON_KC_PASSWORD}"
EXPECT_POLICY="${VAULT_OIDC_EXPECT_POLICY:-policy-oidc-admin}"

ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "OpenBao OIDC login — real authorization-code flow"
echo "================================================="
echo "  user: ${USERNAME}   role: ${ROLE}   realm: ${KC_REALM}"
echo

command -v sops >/dev/null 2>&1 || { bad "sops is required"; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { bad "Container $CONTAINER is not running"; exit 1; }

PASSWORD="$(sops -d --extract "[\"${PASSWORD_KEY}\"]" "$SECRETS_FILE" 2>/dev/null)"
[ -n "$PASSWORD" ] || { bad "${PASSWORD_KEY} not found in ${SECRETS_FILE}"; exit 1; }

# THE REDIRECT URI AND THE CALLBACK PATH ARE NOT THE SAME STRING, and conflating
# them is what made this look like a bound-claim failure. The plugin is mounted at
# `oidc` and its own route is `oidc/callback`, so the real endpoint is
#     /v1/auth/oidc/oidc/callback        <- note the doubled segment
# while `vault.sh setup-oidc` registered `/v1/auth/oidc/callback` until 2026-08-03.
# That path is not a route at all: it answers `permission denied` with nothing in
# the OpenBao log, which reads exactly like a rejected claim.
#
# The default here is deliberately the UI redirect — it was correct even while the
# API one was wrong, so this check works against a vault configured either way.
# The code is redeemed at the API callback regardless: OpenBao exchanges with the
# redirect_uri it stored alongside the state, so the two need not match.
REDIRECT="${VAULT_REDIRECT_URI:-${VAULT_PUBLIC_URL}/ui/vault/auth/oidc/oidc/callback}"
CALLBACK="${VAULT_PUBLIC_URL}/v1/auth/oidc/oidc/callback"

# --- 1. Ask OpenBao where to send the user ---------------------------------
BODY="$(python3 -c 'import json,sys; print(json.dumps({"role": sys.argv[1], "redirect_uri": sys.argv[2]}))' "$ROLE" "$REDIRECT")"
AUTH_JSON="$(curl -sS -X POST -H 'Content-Type: application/json' \
    --data "$BODY" "${VAULT_PUBLIC_URL}/v1/auth/oidc/oidc/auth_url")"

AUTH_URL="$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["data"]["auth_url"])
except Exception: print("")' 2>/dev/null)"

if [ -z "$AUTH_URL" ]; then
    bad "OpenBao did not return an auth_url."
    printf '%s\n' "$AUTH_JSON" | head -3 | sed 's/^/     /'
    echo "     (an empty auth_url usually means role ${ROLE} does not exist, or the"
    echo "      redirect_uri is not in its allowed_redirect_uris)"
    exit 1
fi
ok "OpenBao issued an authorize URL for role ${ROLE}"

# Sanity: it must point at the realm we think it does.
case "$AUTH_URL" in
    "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/auth"*) ok "it points at ${KC_URL}, realm ${KC_REALM}" ;;
    *) bad "unexpected authorize URL host/realm"; echo "     ${AUTH_URL%%\?*}"; exit 1 ;;
esac

# --- 2. Fetch the login form -----------------------------------------------
FORM="$(curl -sS -c "$TMP/cookies" "$AUTH_URL")" || { bad "could not reach Keycloak"; exit 1; }

ACTION="$(printf '%s' "$FORM" | python3 -c '
import sys, re, html
m = re.search(r"<form[^>]*id=\"kc-form-login\"[^>]*action=\"([^\"]+)\"", sys.stdin.read())
print(html.unescape(m.group(1)) if m else "")')"

if [ -z "$ACTION" ]; then
    bad "no Keycloak login form in the response."
    # A user with a pending required action lands somewhere else entirely, and
    # that looks exactly like rejected credentials if you do not check.
    printf '%s' "$FORM" | grep -o "required-action[^\"]*" | head -2 | sed 's/^/     /'
    exit 1
fi
ok "Keycloak served a login form"

# --- 3. Log in, capture the code -------------------------------------------
# --data-urlencode keeps the password out of argv-visible URL assembly and
# handles any character it may contain.
HEADERS="$(curl -sS -b "$TMP/cookies" -c "$TMP/cookies" -D - -o /dev/null \
    --data-urlencode "username=${USERNAME}" \
    --data-urlencode "password=${PASSWORD}" \
    --data-urlencode "credentialId=" \
    "$ACTION")"
unset PASSWORD

LOCATION="$(printf '%s' "$HEADERS" | grep -i '^location:' | tail -1 | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')"

if [ -z "$LOCATION" ]; then
    bad "no redirect after the credential POST — the login did not complete."
    printf '%s' "$HEADERS" | head -1 | sed 's/^/     /'
    exit 1
fi

case "$LOCATION" in
    *code=*) ok "Keycloak issued an authorization code" ;;
    *error=*) bad "Keycloak refused: ${LOCATION#*error=}"; exit 1 ;;
    *required-action*|*login-actions*)
        bad "diverted to a required action — this is NOT rejected credentials."
        echo "     ${LOCATION%%\?*}"
        exit 1 ;;
    *) bad "unexpected redirect: ${LOCATION%%\?*}"; exit 1 ;;
esac

CODE="$(printf '%s' "$LOCATION" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
STATE="$(printf '%s' "$LOCATION" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')"
[ -n "$CODE" ] && [ -n "$STATE" ] || { bad "could not extract code/state"; exit 1; }

# --- 4. Redeem it at OpenBao's callback ------------------------------------
CB="$(curl -sS -G "${CALLBACK}" \
    --data-urlencode "code=${CODE}" --data-urlencode "state=${STATE}")"

POLICIES="$(printf '%s' "$CB" | python3 -c 'import sys,json
try: print(",".join(json.load(sys.stdin)["auth"]["policies"]))
except Exception: print("")' 2>/dev/null)"
HAS_TOKEN="$(printf '%s' "$CB" | python3 -c 'import sys,json
try: print("yes" if json.load(sys.stdin)["auth"]["client_token"] else "no")
except Exception: print("no")' 2>/dev/null)"

if [ "$HAS_TOKEN" != "yes" ]; then
    bad "OpenBao did not issue a token."
    printf '%s\n' "$CB" | head -5 | sed 's/^/     /'
    echo "     A 400 mentioning bound claims means the flow WORKED and the claim did"
    echo "     not match — check the realm role, not the plumbing."
    exit 1
fi
ok "OpenBao issued a token (value not printed)"
ok "policies: ${POLICIES}"

echo
case ",${POLICIES}," in
    *",${EXPECT_POLICY},"*)
        echo "LOGIN PROVEN — ${USERNAME} authenticated by OIDC and received ${EXPECT_POLICY}."
        exit 0 ;;
    *)
        bad "expected ${EXPECT_POLICY} in the policy list, got: ${POLICIES}"
        exit 1 ;;
esac
