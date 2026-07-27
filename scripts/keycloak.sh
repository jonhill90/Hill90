#!/usr/bin/env bash
# Keycloak CLI — idempotent realm configuration for platform SSO
# Usage: keycloak.sh {apply|status|client-secret|help}
#
# WHY THIS EXISTS
#
# platform-realm.json is applied by `start --import-realm`, whose strategy is
# IGNORE_EXISTING. Once the realm exists in Postgres — which it does in
# production as of #531 — editing that file changes nothing, and Keycloak still
# logs "Import finished successfully". See platform/auth/keycloak/README.md.
#
# So every realm change after the first boot has to be applied explicitly. This
# script is that path. It is idempotent: run it as many times as you like.
#
# It configures SSO for the platform services per issue #530. The failure mode
# is designed for, not ignored: every service keeps a working local admin login,
# and nothing here disables one. See docs/runbooks/sso-fallback.md.

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

KC_CONTAINER="${KC_CONTAINER:-keycloak}"
KC_REALM="${KC_REALM:-platform}"
SECRETS_FILE="${KC_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"

# Public base URLs. Defaults are the production values, so an unset environment
# reproduces production exactly — the same contract as the compose files.
KC_PUBLIC_URL="${KC_PUBLIC_URL:-https://auth.hill90.com}"
GRAFANA_PUBLIC_URL="${GRAFANA_PUBLIC_URL:-https://grafana.hill90.com}"
PORTAINER_PUBLIC_URL="${PORTAINER_PUBLIC_URL:-https://portainer.hill90.com}"
VAULT_PUBLIC_URL="${VAULT_PUBLIC_URL:-https://vault.hill90.com}"
MINIO_PUBLIC_URL="${MINIO_PUBLIC_URL:-https://storage.hill90.com}"

# Realm roles mapped onto each service's own role model.
REALM_ROLES="admin editor viewer"

usage() {
    cat <<EOF
Keycloak CLI — idempotent realm configuration for platform SSO

Usage: keycloak.sh <command>

Commands:
  apply                  Ensure realm roles and SSO clients exist and are correct
  status                 Show the realm, its clients and their redirect URIs
  client-secret <id>     Print a client's secret (for wiring another service)
  help                   Show this help message

Environment variables:
  KC_CONTAINER           Keycloak container name (default: keycloak)
  KC_REALM               Realm to operate on (default: platform)
  KC_SECRETS_FILE        SOPS file holding the client secrets
  KC_PUBLIC_URL          Keycloak public base URL (default: ${KC_PUBLIC_URL})
  GRAFANA_PUBLIC_URL     Grafana public base URL
  PORTAINER_PUBLIC_URL   Portainer public base URL
  VAULT_PUBLIC_URL       OpenBao public base URL
  MINIO_PUBLIC_URL       MinIO public base URL

Every default above is the production value. Local development overrides them;
with nothing set, this configures production.
EOF
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

kc() { docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"; }

# kcadm writes its credentials into a file inside the container, so this is done
# once per run rather than per call.
kc_login() {
    local user pass
    user="${KC_ADMIN_USERNAME:-}"
    pass="${KC_ADMIN_PASSWORD:-}"

    if [ -z "$user" ] || [ -z "$pass" ]; then
        require_file "$SECRETS_FILE" "Secrets file"
        ensure_age_key prod
        user="${user:-$(sops -d "$SECRETS_FILE" 2>/dev/null | grep '^KC_ADMIN_USERNAME=' | cut -d= -f2-)}"
        pass="${pass:-$(sops -d "$SECRETS_FILE" 2>/dev/null | grep '^KC_ADMIN_PASSWORD=' | cut -d= -f2-)}"
    fi
    [ -n "$user" ] && [ -n "$pass" ] || die "KC_ADMIN_USERNAME/KC_ADMIN_PASSWORD not available"

    # The password goes through the ENVIRONMENT, not argv. `--password "$pass"`
    # put the Keycloak admin password in the host process list for the duration
    # of the call, readable by any local user. kcadm reads KC_CLI_PASSWORD when
    # --password is absent, and `docker exec -e VAR` (no value) passes the
    # variable through without it ever appearing in a command line.
    #
    # kcadm also prints "Logging into ..." on stderr, and `client-secret` is
    # meant to be consumable by other scripts, so swallow both streams and
    # surface them only if the login actually failed.
    local out
    if ! out=$(KC_CLI_PASSWORD="$pass" docker exec -e KC_CLI_PASSWORD "$KC_CONTAINER" \
                  /opt/keycloak/bin/kcadm.sh config credentials \
                  --server http://127.0.0.1:8080 --realm master --user "$user" 2>&1); then
        echo "$out" >&2
        die "Could not authenticate to Keycloak in container '$KC_CONTAINER'"
    fi
}

require_running() {
    docker inspect "$KC_CONTAINER" >/dev/null 2>&1 \
        || die "Container $KC_CONTAINER is not running. Deploy it first: bash scripts/deploy.sh auth prod"
}

# Read a secret from SOPS, or from the environment if already set.
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

client_uuid() {
    kc get clients -r "$KC_REALM" -q "clientId=$1" --fields id --format csv --noquotes 2>/dev/null \
        | tr -d '\r' | head -n1
}

# ---------------------------------------------------------------------------
# Realm roles
# ---------------------------------------------------------------------------

ensure_realm_roles() {
    echo "Realm roles..."
    local existing
    existing=$(kc get roles -r "$KC_REALM" --fields name --format csv --noquotes 2>/dev/null | tr -d '\r')
    for role in $REALM_ROLES; do
        if echo "$existing" | grep -qx "$role"; then
            echo "  = ${role}"
        else
            kc create roles -r "$KC_REALM" -s "name=${role}" >/dev/null
            echo "  + ${role}"
        fi
    done
}

# ---------------------------------------------------------------------------
# Clients
#
# Each service reads realm roles out of the token, so every client gets a realm
# roles mapper that puts them in the ID token AND the userinfo response —
# Grafana consults the ID token first and falls back to userinfo, and Portainer
# only ever reads its resource URI (userinfo).
# ---------------------------------------------------------------------------

ensure_realm_roles_mapper() {
    local uuid="$1" claim="${2:-realm_access.roles}"

    # Match on the mapper's CLAIM, not just its name. A mapper called
    # "realm-roles" pointing at the wrong claim is worse than a missing one: the
    # client looks configured, tokens look populated, and the consumer's claim
    # binding silently never matches.
    local existing_id existing_claim
    read -r existing_id existing_claim <<<"$(kc get "clients/${uuid}/protocol-mappers/models" -r "$KC_REALM" 2>/dev/null \
        | python3 -c '
import json, sys
try:
    ms = json.load(sys.stdin)
except Exception:
    ms = []
for m in ms:
    if m.get("name") == "realm-roles":
        print(m.get("id", ""), (m.get("config") or {}).get("claim.name", ""))
        break
' 2>/dev/null)"

    if [ -n "${existing_claim:-}" ] && [ "$existing_claim" = "$claim" ]; then
        echo "    = realm-roles mapper (claim ${claim})"
        return 0
    fi

    local mapper
    mapper=$(python3 -c '
import json, sys
print(json.dumps({
    "name": "realm-roles",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-usermodel-realm-role-mapper",
    "config": {
        "claim.name": sys.argv[1],
        "jsonType.label": "String",
        "multivalued": "true",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "userinfo.token.claim": "true",
    },
}))' "$claim")

    # kcadm mis-parses nested JSON passed as positional arguments through
    # docker exec; pipe it on stdin instead. Same trap as OpenBao's bound_claims.
    if [ -n "${existing_id:-}" ]; then
        echo "$mapper" | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
            update "clients/${uuid}/protocol-mappers/models/${existing_id}" -r "$KC_REALM" -f - >/dev/null 2>&1
        echo "    ~ realm-roles mapper corrected (${existing_claim:-none} -> ${claim})"
    else
        echo "$mapper" | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
            create "clients/${uuid}/protocol-mappers/models" -r "$KC_REALM" -f - >/dev/null 2>&1
        echo "    + realm-roles mapper (claim ${claim})"
    fi
}

ensure_client() {
    local client_id="$1" secret="$2" redirects="$3" origins="$4" claim="${5:-realm_access.roles}"

    # Last line of defence for the class of bug where a secret resolves empty.
    # Writing "" over a live client's secret breaks every login for that service
    # while the token exchange still LOOKS like a service fault, so refuse.
    [ -n "$secret" ] || die "Refusing to write an empty client secret for '${client_id}'"

    local payload uuid
    payload=$(python3 -c '
import json, sys
cid, secret, redirects, origins = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
print(json.dumps({
    "clientId": cid,
    "secret": secret,
    "protocol": "openid-connect",
    "publicClient": False,
    "standardFlowEnabled": True,
    "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False,
    "redirectUris": redirects.split(","),
    "webOrigins": origins.split(","),
    "enabled": True,
}))' "$client_id" "$secret" "$redirects" "$origins")

    uuid=$(client_uuid "$client_id")
    if [ -z "$uuid" ]; then
        echo "$payload" | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
            create clients -r "$KC_REALM" -f - >/dev/null
        uuid=$(client_uuid "$client_id")
        [ -n "$uuid" ] || die "Failed to create client ${client_id}"
        echo "  + ${client_id}"
    else
        echo "$payload" | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
            update "clients/${uuid}" -r "$KC_REALM" -f - >/dev/null
        echo "  = ${client_id} (updated)"
    fi

    ensure_realm_roles_mapper "$uuid" "$claim"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_apply() {
    require_running
    kc_login

    echo "================================"
    echo "Keycloak SSO — realm '${KC_REALM}'"
    echo "================================"
    echo ""

    # Resolve EVERY secret before touching anything. secret_for calls die, but
    # die inside $( ) only exits the subshell — so the failure has to be caught
    # here, or apply would carry on with an empty string and still exit 0.
    local grafana_secret portainer_secret vault_secret
    grafana_secret=$(secret_for GRAFANA_OIDC_CLIENT_SECRET) \
        || die "Cannot resolve GRAFANA_OIDC_CLIENT_SECRET — refusing to reconfigure any client"
    portainer_secret=$(secret_for PORTAINER_OIDC_CLIENT_SECRET) \
        || die "Cannot resolve PORTAINER_OIDC_CLIENT_SECRET — refusing to reconfigure any client"
    vault_secret=$(secret_for VAULT_OIDC_CLIENT_SECRET) \
        || die "Cannot resolve VAULT_OIDC_CLIENT_SECRET — refusing to reconfigure any client"
    local minio_secret
    minio_secret=$(secret_for MINIO_OIDC_CLIENT_SECRET) \
        || die "Cannot resolve MINIO_OIDC_CLIENT_SECRET — refusing to reconfigure any client"

    ensure_realm_roles
    echo ""
    echo "Clients..."

    ensure_client "grafana" "$grafana_secret" \
        "${GRAFANA_PUBLIC_URL}/login/generic_oauth,${GRAFANA_PUBLIC_URL}/*" \
        "${GRAFANA_PUBLIC_URL}"

    ensure_client "portainer" "$portainer_secret" \
        "${PORTAINER_PUBLIC_URL}/,${PORTAINER_PUBLIC_URL}/*" \
        "${PORTAINER_PUBLIC_URL}"

    # hill90-vault is created by the realm import. Its claim is realm_roles, NOT
    # realm_access.roles: vault.sh setup-oidc binds
    # bound_claims {"realm_roles": ["admin"]}, so defaulting here would create a
    # mapper OpenBao can never match and SSO would fail for everyone.
    ensure_client "hill90-vault" "$vault_secret" \
        "${VAULT_PUBLIC_URL}/v1/auth/oidc/callback,${VAULT_PUBLIC_URL}/ui/vault/auth/oidc/oidc/callback" \
        "${VAULT_PUBLIC_URL}" \
        "realm_roles"

    # MinIO reads the policy to grant from a dedicated claim, NOT from
    # realm_access.roles: its claim is a policy NAME, and MinIO grants exactly
    # the policy the claim contains. Pointing it at realm_access.roles would
    # hand it a list of role names that are not MinIO policies.
    #
    # The console gets no SSO from this — MinIO removed the console from the
    # AGPL build in May 2025. This gates the S3/STS path only.
    ensure_client "minio" "$minio_secret" \
        "${MINIO_PUBLIC_URL}/oauth_callback,${MINIO_PUBLIC_URL}/*" \
        "${MINIO_PUBLIC_URL}" \
        "${MINIO_OIDC_CLAIM_NAME:-minio_policy}"

    echo ""
    success "Realm '${KC_REALM}' configured."
    echo ""
    echo "  Grant a user access by assigning a realm role:"
    echo "    docker exec ${KC_CONTAINER} /opt/keycloak/bin/kcadm.sh add-roles \\"
    echo "      -r ${KC_REALM} --uusername <user> --rolename admin"
    echo ""
    echo "  Every service keeps its local admin login. If Keycloak is down, see"
    echo "  docs/runbooks/sso-fallback.md."
}

cmd_status() {
    require_running
    kc_login
    echo "Realm: ${KC_REALM}"
    echo ""
    echo "Roles:"
    kc get roles -r "$KC_REALM" --fields name --format csv --noquotes 2>/dev/null \
        | tr -d '\r' | sed 's/^/  /'
    echo ""
    echo "Clients:"
    kc get clients -r "$KC_REALM" --fields clientId,enabled,redirectUris 2>/dev/null \
        | python3 -c '
import json, sys
for c in json.load(sys.stdin):
    print("  %-16s enabled=%s" % (c.get("clientId"), c.get("enabled")))
    for u in c.get("redirectUris") or []:
        print("      %s" % u)
' 2>/dev/null || true
}

cmd_client_secret() {
    [ -n "${1:-}" ] || die "Usage: keycloak.sh client-secret <clientId>"
    require_running
    kc_login
    local uuid; uuid=$(client_uuid "$1")
    [ -n "$uuid" ] || die "No such client: $1"
    kc get "clients/${uuid}/client-secret" -r "$KC_REALM" --fields value --format csv --noquotes 2>/dev/null | tr -d '\r'
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

main() {
    local cmd="${1:-help}"; shift || true
    case "$cmd" in
        apply)          cmd_apply "$@" ;;
        status)         cmd_status "$@" ;;
        client-secret)  cmd_client_secret "$@" ;;
        help|-h|--help) usage ;;
        *)              usage; die "Unknown command: $cmd" ;;
    esac
}

main "$@"
