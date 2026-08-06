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
# platform-admin / platform-viewer are the option-B roles (2026-08-01). They are
# ADDITIVE: admin, user, editor and viewer stay until every consumer is repointed
# and proven, which is a separate change. Removing a role a consumer still binds
# on would break that consumer silently — the binding simply stops matching.
# platform-editor added 2026-08-03. Grafana's role_attribute_path named the
# zero-holder realm role `editor`; Stage 2a repointed only the admin arm and said
# so, leaving the editor arm to the change that proves every consumer. This is
# that change.
#
# A NEW ROLE RATHER THAN REUSING platform-viewer. A Grafana Editor creates and
# edits dashboards, panels and alert rules — it writes. platform-viewer is the
# read-only tier and MinIO already grants it a read-only S3 policy, so pointing
# the Editor arm at it would hand every platform-viewer holder write access in
# Grafana while they stay read-only everywhere else. That is a silent upgrade and
# an incoherent tier. platform-editor starts with zero holders, so nobody's
# effective access changes on the day it lands.
REALM_ROLES="platform-admin platform-editor platform-viewer"

# Roles this repo has RETIRED and actively deletes. Removal is driven by an
# explicit list, not by absence from REALM_ROLES, and that distinction is the
# whole reason this exists:
#
#   `user` was live in the realm and NOT in REALM_ROLES. ensure_realm_roles only
#   creates what is listed, so a role missing from that list is not managed —
#   it is invisible. Deleting by "anything not in REALM_ROLES" would have been a
#   rule that also deleted `default-roles-platform`, `offline_access` and
#   `uma_authorization`, which are Keycloak's own and are held by every user.
#
# So retirement is stated, never inferred. remove_realm_roles refuses to delete a
# role that has holders, so this list cannot become a foot-gun if one is granted
# later.
REALM_ROLES_REMOVED="admin user editor viewer"

# Humans who administer the platform. Granted platform-admin plus the NARROWEST
# realm-management set that was measured to work — see ensure_platform_admins.
#
# This exists because a role granted by hand is lost the next time the realm is
# rebuilt from nothing, and nothing would say so. That is the same class as the
# OIDC-client trap #634 guards: the deploy succeeds, the object is absent, and the
# failure only appears later.
PLATFORM_ADMIN_USERS="${PLATFORM_ADMIN_USERS:-jon}"

usage() {
    cat <<EOF
Keycloak CLI — idempotent realm configuration for platform SSO

Usage: keycloak.sh <command>

Commands:
  apply                  Ensure realm roles and SSO clients exist and are correct
  tenant-clients         Reconcile the TENANT's clients (hill90-ui, hill90-api).
                         platform-realm.json imports only on first boot, so this
                         is how they reach a realm that already exists. Never
                         rewrites an existing client's secret.
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
# Login event storage
# ---------------------------------------------------------------------------

# How long events are kept, in seconds. 30 days.
#
# Chosen, not defaulted. The question this exists to answer — "did this user log
# in, and when" — is almost always asked about the recent past, and 30 days also
# covers "was anything used between the leak and the rotation", which is the
# question this estate actually had to ask twice this week. Longer buys little:
# beyond a month the answer stops being operational and starts being forensic,
# and forensics wants the Loki/Grafana pipeline, not a Keycloak table.
#
# Storage lands in the PLATFORM Postgres — database `keycloak`, tables
# `event_entity` and `admin_event_entity` — which every other platform service
# depends on, so it is bounded on purpose rather than left to grow forever.
# For scale: the whole `keycloak` database was 13 MB with both tables empty, and
# an event row is a few hundred bytes. Keycloak expires rows on a periodic task;
# nothing here needs a cron.
KC_EVENTS_EXPIRATION="${KC_EVENTS_EXPIRATION:-2592000}"

# The event types worth storing, rather than "all of them".
#
# eventsEnabled with an empty enabledEventTypes records EVERY user event,
# including REFRESH_TOKEN on every token refresh — high volume, and none of it
# answers the question. This list is the question, written out.
KC_EVENT_TYPES="${KC_EVENT_TYPES:-LOGIN LOGIN_ERROR LOGOUT LOGOUT_ERROR}"

# Master records logins only. See the comment on cmd_apply's master call.
KC_MASTER_EVENT_TYPES="${KC_MASTER_EVENT_TYPES:-LOGIN LOGIN_ERROR}"

# Turn on event storage for one realm, idempotently.
#
# WHY THIS EXISTS AT ALL: sessions live in Infinispan, not the database, so
# "who is logged in" and "who has ever logged in" are different questions and
# only the second one is answerable from the host. With events off, `event_entity`
# is empty — and an empty `event_entity` is NOT evidence that nobody logged in.
# More than one session this week has had to say that out loud.
#
# admin_events_details is deliberately NOT exposed as an argument. See below.
ensure_event_logging() {
    local realm="$1" expiration="$2" admin_events="$3"; shift 3
    local types="$*"

    # `update events/config` replaces the whole config object, so every field
    # that should survive has to be named here — omitting one silently reverts
    # it to the server default rather than leaving it alone.
    local payload
    payload=$(python3 -c '
import json, sys
realm, expiration, admin_events = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "true"
print(json.dumps({
    "eventsEnabled": True,
    "eventsExpiration": expiration,
    "enabledEventTypes": sys.argv[4:],
    "adminEventsEnabled": admin_events,
    # Details store the full JSON representation of the changed resource in
    # admin_event_entity.representation (a text column — verified in the live
    # schema). A client representation carries its `secret`, so switching this
    # on writes client secrets in plaintext into the platform Postgres, where
    # they would then be picked up by every database backup. The audit value is
    # "who changed what and when", which the operation type and resource path
    # already give. Left off deliberately; do not flip it without a reason that
    # survives that sentence.
    "adminEventsDetailsEnabled": False,
    }))
' "$realm" "$expiration" "$admin_events" $types)

    # `docker exec -i`, NOT the kc() helper: kc() has no -i, so a payload piped
    # into `-f -` never reaches kcadm. ensure_client uses the same direct form
    # for the same reason.
    echo "$payload" | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
        update "events/config" -r "$realm" -f - >/dev/null \
        || die "Failed to enable event logging on realm '${realm}'"

    local days=$(( expiration / 86400 ))
    echo "  = ${realm}: login events ON, ${days}d retention, admin events ${admin_events}, details OFF"
    echo "      types: ${types}"
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

# Delete the retired roles, refusing if anyone still holds one.
#
# THE REFUSAL IS THE POINT. Zero holders was measured before this shipped, but a
# measurement is a fact about a moment. Somebody can grant `admin` between then
# and the next deploy, and a delete that runs anyway would silently strip it.
#
# Holders are checked THREE ways, because a direct-holder query alone would miss
# two paths: a role granted through a GROUP does not appear in roles/<r>/users,
# and a role reached through a COMPOSITE parent appears on neither. All three
# must be empty.
remove_realm_roles() {
    echo "Retired realm roles..."
    local role existing failed=0
    existing=$(kc get roles -r "$KC_REALM" --fields name --format csv --noquotes 2>/dev/null | tr -d '\r')
    for role in $REALM_ROLES_REMOVED; do
        if ! echo "$existing" | grep -qx "$role"; then
            echo "  . ${role} already absent"
            continue
        fi

        # h#746: `... | grep -c . || true` used to make a transient read
        # failure indistinguishable from a genuine "zero holders" result —
        # grep -c on empty stdin (whether because kc get legitimately found
        # nothing, or because it failed and produced no output at all)
        # prints the literal string "0" and exits 1, and `|| true` swallowed
        # that. Whichever of the three checks failed, the role proceeded
        # toward deletion as if the holder-count had genuinely been
        # verified. Extends this file's own existing pattern
        # (ensure_event_logging's `|| die` on a load-bearing write) rather
        # than inventing a new one: each read's own exit status is now
        # checked BEFORE counting, so a failed read refuses the retirement
        # instead of silently counting as zero.
        local users groups parents users_raw groups_raw roles_raw
        if ! users_raw=$(kc get "roles/${role}/users" -r "$KC_REALM" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r'); then
            warn "  ! ${role} NOT deleted — could not read current USER holders (the query failed). A failed read is not the same as zero holders; retirement is blocked until it succeeds."
            failed=1
            continue
        fi
        users=$(printf '%s' "$users_raw" | grep -c . || true)

        if ! groups_raw=$(kc get "roles/${role}/groups" -r "$KC_REALM" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r'); then
            warn "  ! ${role} NOT deleted — could not read current GROUP holders (the query failed). A failed read is not the same as zero holders; retirement is blocked until it succeeds."
            failed=1
            continue
        fi
        groups=$(printf '%s' "$groups_raw" | grep -c . || true)

        # Composite parents: any role whose composites include this one. The
        # outer list of candidate roles is read explicitly for the same
        # reason as users/groups above — its failure would otherwise zero
        # out every composite-parent check at once, not just one role's.
        if ! roles_raw=$(kc get roles -r "$KC_REALM" --fields name --format csv --noquotes 2>/dev/null | tr -d '\r'); then
            warn "  ! ${role} NOT deleted — could not read the realm's role list to check composite parents (the query failed). A failed read is not the same as zero holders; retirement is blocked until it succeeds."
            failed=1
            continue
        fi
        parents=$(printf '%s' "$roles_raw" | while read -r other; do
            [ -n "$other" ] || continue
            [ "$other" = "$role" ] && continue
            kc get "roles/${other}/composites" -r "$KC_REALM" --fields name --format csv --noquotes 2>/dev/null \
                | tr -d '\r' | grep -qx "$role" && echo "$other"
        done | grep -c . || true)

        if [ "$users" -ne 0 ] || [ "$groups" -ne 0 ] || [ "$parents" -ne 0 ]; then
            warn "  ! ${role} NOT deleted — holders found (users=${users} groups=${groups} composite-parents=${parents}). Retirement is blocked until it has none; do not force it."
            failed=1
            continue
        fi

        kc delete "roles/${role}" -r "$KC_REALM" >/dev/null 2>&1 \
            && echo "  - ${role} deleted (0 users, 0 groups, 0 composite parents)" \
            || { warn "  ! ${role} could not be deleted"; failed=1; }
    done
    # h#749: every warn above used to be logged and then forgotten — cmd_apply
    # printed an unconditional "Realm configured." regardless of how many of
    # these fired. Returning the accumulated status is what lets the caller
    # actually gate its own final message on it, the same accumulator shape
    # local.sh's cmd_health already uses for its own per-check loop.
    return "$failed"
}

# Grant the platform administrators their roles, idempotently.
#
# THE NARROW SET IS NARROW ON PURPOSE, AND IT WAS MEASURED, NOT ASSUMED.
# realm-admin would work and grants everything. These three were tested against
# the live admin API on 2026-08-01 and are what actually lets a human administer
# users and their role assignments:
#
#   manage-users   create/edit users, assign and remove their role mappings
#   view-clients   see clients, which is required to assign CLIENT roles
#   view-realm     load the realm in the console at all
#
# What they deliberately do NOT permit, measured the same way (403 on each):
# creating realm roles, creating or managing clients, changing realm settings,
# viewing identity providers, and viewing login events. Widening is a decision,
# not an oversight — see docs/decisions/stage1-platform-roles.md.
#
# ON A FRESH REALM THIS IS A NO-OP, AND IT SAYS SO LOUDLY. platform-realm.json
# ships ZERO users by design, so after a rebuild there is no `jon` to grant to.
# The roles are created by ensure_realm_roles regardless; the GRANT waits for the
# user to exist. A silent skip here would be exactly the drift this function is
# meant to close, so it warns.
ensure_platform_admins() {
    echo "Platform administrators..."
    # h#749: `missing` and `grant_failed` are tracked SEPARATELY on purpose.
    # A missing user on a fresh realm is documented above as an EXPECTED
    # no-op ("ON A FRESH REALM THIS IS A NO-OP, AND IT SAYS SO LOUDLY"), not
    # a failure — folding it into the same signal a real grant failure uses
    # would make cmd_apply warn on every normal fresh-realm bootstrap. Only
    # grant_failed feeds this function's return status; missing stays
    # informational, exactly as it already was.
    local user uuid missing=0 grant_failed=0
    for user in $PLATFORM_ADMIN_USERS; do
        uuid=$(kc get users -r "$KC_REALM" -q "username=${user}" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' | head -1)
        if [ -z "$uuid" ]; then
            warn "  ! ${user} does not exist in realm '${KC_REALM}' — cannot grant. Create the user, then re-run: bash scripts/keycloak.sh apply"
            missing=$((missing + 1))
            continue
        fi
        # add-roles is idempotent in kcadm: re-adding an existing mapping is a no-op.
        kc add-roles -r "$KC_REALM" --uusername "$user" --rolename platform-admin >/dev/null 2>&1 \
            && echo "  = ${user}: platform-admin" \
            || { warn "  ! ${user}: could not grant platform-admin"; grant_failed=1; }
        local rmrole
        # view-events added 2026-08-02. Event storage was deliberately enabled so
        # that "has anyone logged in, and when" is answerable — and it is not
        # answerable from the admin console without this role. Measured before
        # adding it: GET /admin/realms/platform/events returned 403 for jon.
        for rmrole in manage-users view-clients view-realm view-events; do
            kc add-roles -r "$KC_REALM" --uusername "$user" --cclientid realm-management --rolename "$rmrole" >/dev/null 2>&1 \
                && echo "  = ${user}: realm-management:${rmrole}" \
                || { warn "  ! ${user}: could not grant realm-management:${rmrole}"; grant_failed=1; }
        done
    done
    [ "$missing" -eq 0 ] || warn "  ${missing} administrator(s) not present. On a rebuilt realm this is expected until the accounts are recreated — the realm import ships no users."
    return "$grant_failed"
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

    # h#749: individual warn() calls inside remove_realm_roles and
    # ensure_platform_admins used to be logged and then forgotten — this
    # function ended with an unconditional "Realm configured." regardless of
    # how many of them fired, e.g. one of five per-user role grants failing
    # partway through. `apply_failed` aggregates both, matching the
    # accumulator shape local.sh's cmd_health already uses for its own
    # per-check loop.
    local apply_failed=0

    ensure_realm_roles
    # AFTER creating the replacements, never before: a run that deleted the old
    # roles and then failed would leave the realm with neither.
    remove_realm_roles || apply_failed=1
    ensure_platform_admins || apply_failed=1

    echo ""
    echo "Event logging..."
    # The tenant realm: user logins. This is the one that answers "has anyone
    # actually logged in", which nothing on the host could answer before.
    #
    # Admin events ON here, because this realm's configuration is supposed to
    # arrive through this script from git. A change made by hand in the admin
    # console is exactly the drift nothing else would record, and the resource
    # path plus operation type is enough to spot it. Details stay off — see
    # ensure_event_logging.
    ensure_event_logging "$KC_REALM" "$KC_EVENTS_EXPIRATION" true $KC_EVENT_TYPES

    # MASTER IS A SEPARATE DECISION, not the same one applied twice.
    #
    # Master holds no application users, so "did a user log in" is not a question
    # anyone asks of it. The reason to record here is narrower and concrete: the
    # master admin credential leaked and was rotated on 2026-07-30, and without a
    # login record there is no way to answer whether it was used in between. That
    # question will recur at the next rotation.
    #
    # So: logins only, and LOGOUT is dropped — on an admin realm a logout tells
    # you nothing the login did not. Admin events ON for the same
    # console-drift reason as above, still without details.
    ensure_event_logging master "$KC_EVENTS_EXPIRATION" true $KC_MASTER_EVENT_TYPES

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
    # bound_claims {"realm_roles": ["platform-admin"]}, so defaulting here would create a
    # mapper OpenBao can never match and SSO would fail for everyone.
    # The API callback is /v1/auth/oidc/OIDC/callback — the mount path and the
    # plugin's own route are both `oidc`. This list read /v1/auth/oidc/callback,
    # which is not a route: it answers `permission denied` with nothing logged,
    # indistinguishable from a rejected claim. Corrected 2026-08-03; the UI entry
    # was always right, so browser logins never saw it.
    ensure_client "hill90-vault" "$vault_secret" \
        "${VAULT_PUBLIC_URL}/v1/auth/oidc/oidc/callback,${VAULT_PUBLIC_URL}/ui/vault/auth/oidc/oidc/callback" \
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
    if [ "$apply_failed" -eq 0 ]; then
        success "Realm '${KC_REALM}' configured."
    else
        warn "Realm '${KC_REALM}' configured with warnings above — some role retirements or admin grants did not complete. Re-run 'bash scripts/keycloak.sh apply' after addressing them."
    fi
    echo ""
    echo "  Grant a user access by assigning a realm role:"
    echo "    docker exec ${KC_CONTAINER} /opt/keycloak/bin/kcadm.sh add-roles \\"
    echo "      -r ${KC_REALM} --uusername <user> --rolename platform-admin"
    echo ""
    echo "  Every service keeps its local admin login. If Keycloak is down, see"
    echo "  docs/runbooks/sso-fallback.md."

    [ "$apply_failed" -eq 0 ] || return 1
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

# ---------------------------------------------------------------------------
# The tenant's clients
#
# platform-realm.json declares hill90-ui and hill90-api, but `start --import-realm`
# uses IGNORE_EXISTING: the file is read ONLY on first boot. So declaring them
# there does nothing to a realm that already exists — production's, or any
# developer's local stack that was up before the declaration landed. That is the
# same trap deploy.sh:399 records for the SSO clients, and the reason this
# reconcile exists.
#
# Two things this deliberately does NOT do:
#
#   1. It never rewrites an existing client's secret. Production's hill90-ui holds
#      a live secret that works, and HILL90_UI_CLIENT_SECRET has no production
#      value in the store yet. Reconciling the secret would break every login and
#      look like a service fault. Absent client -> secret required; present client
#      -> credentials untouched.
#
#   2. It never adds a realm-roles mapper, and REMOVES one if it finds it. Every
#      other client here gets one; these two must not. This realm grants Grafana
#      Admin and OpenBao off the REALM role `admin`, and the app reads
#      resource_access.<client>.roles precisely so an app admin does not inherit
#      infrastructure admin. resource_access comes from the built-in `roles`
#      client scope, so no per-client mapper is needed at all.
# ---------------------------------------------------------------------------

ensure_client_roles() {
    local uuid="$1"; shift
    local existing role failed=0
    existing=$(kc get "clients/${uuid}/roles" -r "$KC_REALM" --fields name --format csv --noquotes 2>/dev/null | tr -d '\r')
    for role in "$@"; do
        if echo "$existing" | grep -qx "$role"; then
            echo "    = client role ${role}"
        else
            kc create "clients/${uuid}/roles" -r "$KC_REALM" -s "name=${role}" >/dev/null 2>&1 \
                && echo "    + client role ${role}" \
                || { warn "could not create client role ${role}"; failed=1; }
        fi
    done
    # h#749: same accumulator shape as remove_realm_roles/ensure_platform_admins
    # — a per-role warn used to be logged and then forgotten by cmd_tenant_clients.
    return "$failed"
}

ensure_audience_mapper() {
    local uuid="$1" audience="$2"
    local found
    found=$(kc get "clients/${uuid}/protocol-mappers/models" -r "$KC_REALM" 2>/dev/null | python3 -c '
import json, sys
try:
    ms = json.load(sys.stdin)
except Exception:
    ms = []
for m in ms:
    if m.get("protocolMapper") == "oidc-audience-mapper" \
       and (m.get("config") or {}).get("included.client.audience") == sys.argv[1]:
        print(m.get("id", "")); break
' "$audience" 2>/dev/null)
    if [ -n "$found" ]; then
        echo "    = audience mapper (${audience})"
        return 0
    fi
    python3 -c '
import json, sys
print(json.dumps({
    "name": sys.argv[1] + "-audience",
    "protocol": "openid-connect",
    "protocolMapper": "oidc-audience-mapper",
    "config": {
        "included.client.audience": sys.argv[1],
        "access.token.claim": "true",
        "id.token.claim": "false",
    },
}))' "$audience" \
      | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
          create "clients/${uuid}/protocol-mappers/models" -r "$KC_REALM" -f - >/dev/null 2>&1 \
      && echo "    + audience mapper (${audience})" \
      || warn "could not create the ${audience} audience mapper — the api will reject the UI's tokens"
}

# The inverse of ensure_realm_roles_mapper: assert ABSENCE, and repair it.
remove_realm_roles_mapper() {
    local uuid="$1" client_id="$2"
    local ids
    ids=$(kc get "clients/${uuid}/protocol-mappers/models" -r "$KC_REALM" 2>/dev/null | python3 -c '
import json, sys
try:
    ms = json.load(sys.stdin)
except Exception:
    ms = []
for m in ms:
    if m.get("protocolMapper") in ("oidc-usermodel-realm-role-mapper",
                                   "oidc-usermodel-role-mapper"):
        print(m.get("id",""))
' 2>/dev/null)
    local id
    for id in $ids; do
        [ -n "$id" ] || continue
        kc delete "clients/${uuid}/protocol-mappers/models/${id}" -r "$KC_REALM" >/dev/null 2>&1
        warn "REMOVED a realm-roles mapper from ${client_id}. That mapper would let an app role inherit the realm 'admin' grant (Grafana Admin, OpenBao). It must not be there."
    done
}

cmd_tenant_clients() {
    require_running
    kc_login

    local ui_redirects="${HILL90_UI_REDIRECT_URIS:-https://hill90.com/api/auth/callback/keycloak}"
    local ui_origins="${HILL90_UI_WEB_ORIGINS:-https://hill90.com}"
    local ui_secret="${HILL90_UI_CLIENT_SECRET:-}"

    echo "Tenant clients in realm '${KC_REALM}'..."

    # --- hill90-api: bearer-only, no flows, no secret needed ---------------
    local api_uuid; api_uuid=$(client_uuid "hill90-api")
    if [ -z "$api_uuid" ]; then
        python3 -c '
import json
print(json.dumps({
    "clientId": "hill90-api", "protocol": "openid-connect", "enabled": True,
    "publicClient": False, "bearerOnly": True,
    "standardFlowEnabled": False, "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False, "fullScopeAllowed": True,
}))' | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
                create clients -r "$KC_REALM" -f - >/dev/null 2>&1
        api_uuid=$(client_uuid "hill90-api")
        [ -n "$api_uuid" ] || die "Failed to create client hill90-api"
        echo "  + hill90-api (bearer-only)"
    else
        echo "  = hill90-api"
    fi

    # --- hill90-ui --------------------------------------------------------
    #
    # Both branches below pin defaultClientScopes explicitly, and both must
    # include 'basic' — added for #704. Keycloak 24+ emits the `sub` claim via
    # 'basic', and hill90-app reads user.sub at 158 call sites. hill90-app#306
    # IS deployed as of 2026-08-04 ~15:20 UTC (verified: api/ai/knowledge/mcp/
    # ui all on 22a6b44) and the api now refuses a token with no `sub` — a
    # client created without 'basic', right now, authenticates nobody at all.
    # Earlier the same day, before #306 shipped, the identical gap would have
    # been silent instead: a subject-less token accepted and ownership scoped
    # by `undefined`. Both states are worth keeping in this comment, because
    # this is the one that got WORSE the moment the security fix deployed —
    # re-check the deployed SHA before repeating either claim; do not assume
    # this comment's date still describes the live state.
    #
    # This is not just a rebuild-time concern: the RECONCILE branch (the
    # `else` below) runs `kcadm update` against a client that may already be
    # correct, so a scope list here that omitted 'basic' would have STRIPPED
    # it from a working production client
    # the next time this command ran — actively regressing a client that had
    # it, not merely failing to grant it to a new one. platform-realm.json
    # carries the same list for the same reason; the two must move together.
    local ui_uuid; ui_uuid=$(client_uuid "hill90-ui")
    if [ -z "$ui_uuid" ]; then
        [ -n "$ui_secret" ] || die "hill90-ui does not exist and HILL90_UI_CLIENT_SECRET is empty — refusing to create a login client with no secret"
        python3 -c '
import json, sys
print(json.dumps({
    "clientId": "hill90-ui", "secret": sys.argv[1], "protocol": "openid-connect",
    "enabled": True, "publicClient": False, "bearerOnly": False,
    "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False, "fullScopeAllowed": True,
    "redirectUris": sys.argv[2].split(","), "webOrigins": sys.argv[3].split(","),
    "defaultClientScopes": ["web-origins", "acr", "roles", "basic", "profile", "email"],
}))' "$ui_secret" "$ui_redirects" "$ui_origins" \
          | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
                create clients -r "$KC_REALM" -f - >/dev/null 2>&1
        ui_uuid=$(client_uuid "hill90-ui")
        [ -n "$ui_uuid" ] || die "Failed to create client hill90-ui"
        echo "  + hill90-ui (confidential)"
    else
        # Reconcile URLs and flags only. NOT the secret — see the header.
        python3 -c '
import json, sys
print(json.dumps({
    "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
    "publicClient": False, "bearerOnly": False, "fullScopeAllowed": True,
    "redirectUris": sys.argv[1].split(","), "webOrigins": sys.argv[2].split(","),
    "defaultClientScopes": ["web-origins", "acr", "roles", "basic", "profile", "email"],
}))' "$ui_redirects" "$ui_origins" \
          | docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh \
                update "clients/${ui_uuid}" -r "$KC_REALM" -f - >/dev/null 2>&1
        echo "  = hill90-ui (URLs and flags reconciled; secret untouched)"
    fi

    # h#749: a per-role warn inside ensure_client_roles used to be logged and
    # then forgotten — this function ended unconditionally with "reconciled"
    # regardless of whether every client role actually got created.
    local tenant_failed=0
    ensure_client_roles "$ui_uuid" user admin || tenant_failed=1
    ensure_audience_mapper "$ui_uuid" "hill90-api"
    remove_realm_roles_mapper "$ui_uuid" "hill90-ui"
    remove_realm_roles_mapper "$api_uuid" "hill90-api"

    echo ""
    if [ "$tenant_failed" -eq 0 ]; then
        success "Tenant clients reconciled in realm '${KC_REALM}'."
    else
        warn "Tenant clients reconciled in realm '${KC_REALM}' with warnings above — not every client role could be created. Re-run 'bash scripts/keycloak.sh tenant-clients' after addressing them."
    fi

    [ "$tenant_failed" -eq 0 ] || return 1
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
        tenant-clients) cmd_tenant_clients "$@" ;;
        status)         cmd_status "$@" ;;
        client-secret)  cmd_client_secret "$@" ;;
        help|-h|--help) usage ;;
        *)              usage; die "Unknown command: $cmd" ;;
    esac
}

main "$@"
