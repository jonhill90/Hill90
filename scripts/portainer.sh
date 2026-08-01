#!/usr/bin/env bash
# Portainer CLI — configure OAuth (Keycloak) against the Portainer API
# Usage: portainer.sh {apply|status|help}
#
# Portainer keeps authentication settings in its OWN database, not in compose
# environment, so this cannot be expressed as a ${VAR} like Grafana's. It is
# applied through the API, idempotently.
#
# EDITION LIMITS — Portainer Community Edition, verified against 2.39.5:
#   * Generic OAuth login: supported.
#   * Automatic user provisioning: supported.
#   * Group/claim -> team mapping and automatic admin rights: BUSINESS ONLY.
# So an SSO user arrives as a STANDARD user. Granting Portainer admin is a
# manual, one-time step per person — see docs/runbooks/portainer-sso-admin.md.
#
# THE LOCAL ADMIN LOGIN IS NEVER DISABLED. Portainer's OAuth settings include
# an "SSO"/hide-internal-auth behaviour; this script leaves internal
# authentication reachable so Keycloak is never the only way in.

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

PORTAINER_URL="${PORTAINER_INTERNAL_URL:-http://localhost:9000}"
PORTAINER_CONTAINER="${PORTAINER_CONTAINER:-portainer}"
SECRETS_FILE="${PORTAINER_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"

KC_PUBLIC_URL="${KC_PUBLIC_URL:-https://auth.hill90.com}"
KC_REALM="${KC_REALM:-platform}"
PORTAINER_PUBLIC_URL="${PORTAINER_PUBLIC_URL:-https://portainer.hill90.com}"

usage() {
    cat <<EOF
Portainer CLI — configure Keycloak OAuth through the Portainer API

Usage: portainer.sh <command>

Commands:
  init      Create the local admin if none exists (idempotent)
  apply     Configure OAuth against Keycloak (idempotent; runs init first)
  status    Show the current authentication configuration
  help      Show this help message

Environment variables:
  PORTAINER_INTERNAL_URL      API base URL (default: ${PORTAINER_URL})
  PORTAINER_PUBLIC_URL        Public base URL used for the OAuth redirect
  PORTAINER_ADMIN_USERNAME    Local admin username (default: admin)
  PORTAINER_ADMIN_PASSWORD    Local admin password (from SOPS if unset)
  PORTAINER_OIDC_CLIENT_SECRET  OAuth client secret (from SOPS if unset)
  KC_PUBLIC_URL / KC_REALM    Keycloak location

Defaults are the production values.
EOF
}

secret_for() {
    local var="$1" value="${!1:-}"
    if [ -z "$value" ]; then
        require_file "$SECRETS_FILE" "Secrets file"
        ensure_age_key prod
        value=$(sops -d "$SECRETS_FILE" 2>/dev/null | grep "^${var}=" | cut -d= -f2- || true)
    fi
    [ -n "$value" ] || die "${var} is not set and was not found in ${SECRETS_FILE}"
    printf '%s' "$value"
}

api() { # method path [json]
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sS -X "$method" "${PORTAINER_URL}${path}" \
            -H "Authorization: Bearer ${PORTAINER_JWT}" \
            -H "Content-Type: application/json" -d "$body"
    else
        curl -sS -X "$method" "${PORTAINER_URL}${path}" \
            -H "Authorization: Bearer ${PORTAINER_JWT}"
    fi
}

portainer_login() {
    local user pass body
    user="${PORTAINER_ADMIN_USERNAME:-admin}"
    pass=$(secret_for PORTAINER_ADMIN_PASSWORD)
    body=$(python3 -c 'import json,sys;print(json.dumps({"Username":sys.argv[1],"Password":sys.argv[2]}))' "$user" "$pass")

    # `-d @-` reads the body from stdin so the admin password never appears in
    # the host process list.
    local resp
    resp=$(printf '%s' "$body" | curl -sS -X POST "${PORTAINER_URL}/api/auth" \
             -H "Content-Type: application/json" -d @- 2>&1) \
        || die "Cannot reach Portainer at ${PORTAINER_URL}"

    PORTAINER_JWT=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("jwt",""))' 2>/dev/null || true)
    [ -n "$PORTAINER_JWT" ] || die "Portainer login failed as '${user}': ${resp}"
    export PORTAINER_JWT
}

# Portainer 2.39 refuses admin creation without a setup token printed in its
# logs at startup, and it stops accepting one a few minutes after boot ("the
# Portainer instance timed out for security purposes"). Both behaviours are
# security features; both make first-run automation fiddly, so handle them
# explicitly rather than failing with "Invalid credentials", which is what an
# uninitialised Portainer actually returns.
cmd_init() {
    # 204 = an admin exists. 404 = none yet.
    local code
    # curl already writes 000 into %{http_code} when it cannot connect; adding
    # `|| echo 000` concatenated the two and reported "HTTP 000000".
    # `|| true` because curl exits non-zero when it cannot connect and `set -e`
    # would abort before the diagnostic below. curl still writes 000 to stdout.
    code=$(curl -s -o /dev/null -w '%{http_code}' "${PORTAINER_URL}/api/users/admin/check" 2>/dev/null) || true
    if [ "$code" = "204" ]; then
        echo "  = local admin already exists"
        return 0
    fi
    if [ "$code" = "000" ]; then
        die "Cannot reach Portainer at ${PORTAINER_URL}. On the VPS the API is
  published on loopback only (127.0.0.1:9000); set PORTAINER_INTERNAL_URL if
  yours differs."
    fi
    if [ "$code" != "404" ]; then
        die "Unexpected response from Portainer admin check (HTTP ${code}) at ${PORTAINER_URL}"
    fi

    local user pass token
    user="${PORTAINER_ADMIN_USERNAME:-admin}"
    pass=$(secret_for PORTAINER_ADMIN_PASSWORD)

    # The token is logged with ANSI colour codes around it, so strip them first
    # or the value comes back empty.
    token=$(docker logs "$PORTAINER_CONTAINER" 2>&1 \
            | sed -E 's/\x1b\[[0-9;]*m//g' \
            | grep -o 'setup_token=[0-9a-f]\{32,\}' | tail -1 | cut -d= -f2 || true)

    if [ -z "$token" ]; then
        die "No setup token found in '${PORTAINER_CONTAINER}' logs. Portainer only
  prints one while it has no admin, and stops accepting it a few minutes after
  start. Restart the container and re-run: docker restart ${PORTAINER_CONTAINER}"
    fi

    local body resp
    body=$(python3 -c 'import json,sys;print(json.dumps({"Username":sys.argv[1],"Password":sys.argv[2]}))' "$user" "$pass")
    resp=$(printf '%s' "$body" | curl -sS -X POST "${PORTAINER_URL}/api/users/admin/init" \
             -H "Content-Type: application/json" -H "X-Setup-Token: ${token}" -d @-)

    printf '%s' "$resp" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if "Id" not in d:
    print(d); raise SystemExit(1)
' >/dev/null 2>&1 || die "Portainer admin init failed: ${resp}"
    echo "  + local admin '${user}' created"
}

cmd_apply() {
    cmd_init
    portainer_login

    local secret payload
    secret=$(secret_for PORTAINER_OIDC_CLIENT_SECRET)

    # AuthenticationMethod: 1=internal, 2=LDAP, 3=OAuth.
    #
    # SSO=false is deliberate and is the fallback guarantee: with SSO enabled
    # Portainer skips its own login form, which would make Keycloak the only way
    # in. Leaving it false keeps the username/password form on the login page
    # next to the OAuth button.
    payload=$(python3 -c '
import json, sys
kc_base, realm, portainer_base, client_secret = sys.argv[1:5]
issuer = "%s/realms/%s/protocol/openid-connect" % (kc_base.rstrip("/"), realm)
print(json.dumps({
    "AuthenticationMethod": 3,
    "OAuthSettings": {
        "ClientID": "portainer",
        "ClientSecret": client_secret,
        "AuthorizationURI": issuer + "/auth",
        "AccessTokenURI": issuer + "/token",
        "ResourceURI": issuer + "/userinfo",
        "LogoutURI": issuer + "/logout",
        "RedirectURI": portainer_base.rstrip("/") + "/",
        "UserIdentifier": "preferred_username",
        "Scopes": "openid email profile",
        "OAuthAutoCreateUsers": True,
        "DefaultTeamID": 0,
        "SSO": False,
        "AuthStyle": 0,
    },
}))' "$KC_PUBLIC_URL" "$KC_REALM" "$PORTAINER_PUBLIC_URL" "$secret")

    local out
    out=$(api PUT /api/settings "$payload")
    printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
o = d.get("OAuthSettings", {})
assert d.get("AuthenticationMethod") == 3, d.get("AuthenticationMethod")
assert not o.get("SSO"), "SSO is on — the internal login form would be hidden"
print("  authentication method: OAuth")
print("  authorization URI:     %s" % o.get("AuthorizationURI"))
print("  redirect URI:          %s" % o.get("RedirectURI"))
print("  auto-create users:     %s" % o.get("OAuthAutoCreateUsers"))
print("  internal login form:   kept (SSO=false)")
' || die "Portainer did not apply the settings as expected: $out"

    echo ""
    success "Portainer OAuth configured against Keycloak."
    echo ""
    echo "  Portainer CE cannot map claims to admin rights, so the first SSO"
    echo "  login lands as a STANDARD user. Promote once, as local admin:"
    echo "    Users -> <user> -> set Role to Administrator"
}

cmd_status() {
    portainer_login
    api GET /api/settings | python3 -c '
import json, sys
d = json.load(sys.stdin)
m = {1: "internal", 2: "LDAP", 3: "OAuth"}
o = d.get("OAuthSettings", {})
print("  method:              %s" % m.get(d.get("AuthenticationMethod"), d.get("AuthenticationMethod")))
print("  client id:           %s" % o.get("ClientID"))
print("  authorization URI:   %s" % o.get("AuthorizationURI"))
print("  redirect URI:        %s" % o.get("RedirectURI"))
print("  auto-create users:   %s" % o.get("OAuthAutoCreateUsers"))
print("  SSO (hides form):    %s" % o.get("SSO"))
'
}

main() {
    local cmd="${1:-help}"; shift || true
    case "$cmd" in
        init)           cmd_init "$@" ;;
        apply)          cmd_apply "$@" ;;
        status)         cmd_status "$@" ;;
        help|-h|--help) usage ;;
        *)              usage; die "Unknown command: $cmd" ;;
    esac
}

main "$@"
