#!/usr/bin/env bash
# Assert that after a realm import, no Keycloak client secret is an
# unsubstituted ${...} placeholder — h#835.
#
# THE FAILURE THIS CATCHES: platform-realm.json declares hill90-vault's and
# hill90-ui's secrets as ${VAULT_OIDC_CLIENT_SECRET} / ${HILL90_UI_CLIENT_SECRET}.
# `start --import-realm` substitutes them from the container's environment.
# VAULT_OIDC_CLIENT_SECRET is guarded at the compose level (${VAR:?...}), so a
# deploy with it unset refuses before Keycloak ever starts. HILL90_UI_CLIENT_SECRET
# is deliberately NOT guarded there (fad9fefa) — it is legitimately unset on
# every routine `auth` deploy after the first import, and a compose-level guard
# would refuse every one of those. So an import that runs with it unset (a VPS
# rebuild, specifically) succeeds silently, and the resulting client secret for
# hill90-ui — the client fronting hill90.com — is the literal, unsubstituted
# string "${HILL90_UI_CLIENT_SECRET}". This repository is public, so that exact
# string is readable in platform-realm.json by anyone, without needing to guess it.
#
# WHY THIS IS NOT check_env_surface.py'S JOB: that check already guarantees (its
# rule 4) that HILL90_UI_CLIENT_SECRET carries no non-empty compose default, which
# stops a KNOWN bad value from ever being configured as a silent fallback. It is a
# static check of the compose YAML text. It cannot see what THIS script checks:
# Keycloak's own import-time substitution behavior when the variable is genuinely
# absent, which only exists once a real import has actually run. That is why this
# has to ask a live realm, not read the template file — platform-realm.json always
# contains the literal ${...} placeholder, correctly, and always will.
#
# WHY THIS IS SCOPED THE WAY IT IS, DELIBERATELY NARROW: this checks exactly one
# shape — a ${...}-looking literal landing as a CLIENT SECRET after an import —
# not a general realm validator. It generalises to any future templated secret
# field without being rewritten, but it does not grow into checking anything else
# about the realm.
#
# "CANNOT DETERMINE" IS NOT "PASS": an unreachable Keycloak, a failed admin login,
# or an empty client list must never read as "no placeholder found" — each is its
# own distinct outcome. An empty query result silently passing as clean is the
# exact trap this repo has already named once (h#736/h#758's shape, applied here
# to a query result instead of a check-invocation record).
#
# Usage:
#   check_realm_secret_not_literal.sh <container> <realm> <admin-user> <admin-password>
#
# Exit codes:
#   0  PASS               every confidential client's secret is real, not a ${...} literal
#   1  PLACEHOLDER FOUND   at least one client secret IS an unsubstituted ${...} literal
#   2  CANNOT DETERMINE    Keycloak unreachable, admin auth failed, or the client query was empty/unparseable
set -uo pipefail

# argv-ok: this script's admin-password argument is only ever a disposable
# throwaway credential for a container the CALLER creates and destroys (see
# realm-secret-substitution-test.sh) — never a real one. Production reuses
# keycloak.sh's own already-authenticated kc() session instead of calling
# this script at all (verify_realm_secrets_substituted, wired into
# cmd_apply), for exactly the reason kc_login itself passes the real admin
# password through the environment rather than argv.
CONTAINER="${1:?Usage: check_realm_secret_not_literal.sh <container> <realm> <admin-user> <admin-password>}"
REALM="${2:?realm required}"
ADMIN_USER="${3:?admin user required}"
ADMIN_PW="${4:?admin password required}"

say()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; }

kc() { docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh "$@" 2>&1; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    fail "CANNOT DETERMINE: container '${CONTAINER}' does not exist — Keycloak is unreachable, not proven clean."
    exit 2
fi

# argv-ok: caller-supplied credentials for a container this script does not
# create or own; same pattern as realm-tenant-serves-test.sh's own kcadm login.
if ! kc config credentials --server http://127.0.0.1:8080 --realm master \
       --user "$ADMIN_USER" --password "$ADMIN_PW" >/dev/null 2>&1; then
    fail "CANNOT DETERMINE: kcadm admin login failed against '${CONTAINER}' — cannot query client secrets, not proven clean."
    exit 2
fi

CLIENTS_RAW=$(kc get clients -r "$REALM" --fields id,clientId,publicClient --format csv --noquotes 2>/dev/null | tr -d '\r')
if [ -z "$CLIENTS_RAW" ]; then
    fail "CANNOT DETERMINE: the client list for realm '${REALM}' came back empty. An empty result is not the same as 'no placeholders found' — it usually means the query itself failed. Not proven clean."
    exit 2
fi

say "Checking every confidential client's secret in realm '${REALM}' for an unsubstituted \${...} literal"
found=0
checked=0
while IFS=, read -r id client_id public; do
    [ -n "$id" ] || continue
    if [ "$public" = "true" ]; then
        say "  ${client_id}: public client, no secret to check — skipped"
        continue
    fi
    secret_raw=$(kc get "clients/${id}/client-secret" -r "$REALM" --fields value --format csv --noquotes 2>/dev/null | tr -d '\r')
    if [ -z "$secret_raw" ]; then
        # A confidential client can legitimately have no stored secret (e.g. a
        # bearer-only client Keycloak never issued a login secret for) — that
        # is absence, not a substitution failure, so it is reported and
        # skipped rather than treated as CANNOT DETERMINE for the whole run.
        say "  ${client_id}: confidential, no secret value returned — skipped (not a substitution failure)"
        continue
    fi
    checked=$((checked + 1))
    if [[ "$secret_raw" =~ ^\$\{[A-Za-z0-9_]+\}$ ]]; then
        fail "PLACEHOLDER FOUND: client '${client_id}' secret is the literal unsubstituted string '${secret_raw}' — the import ran with the backing variable unset or empty, and the client secret is now a public template value."
        found=1
    else
        say "  ${client_id}: secret substituted (not a literal placeholder)"
    fi
done <<< "$CLIENTS_RAW"

if [ "$checked" -eq 0 ]; then
    fail "CANNOT DETERMINE: no confidential client returned a secret to check at all — not proven clean."
    exit 2
fi

if [ "$found" -eq 1 ]; then
    exit 1
fi
say "PASS: checked ${checked} confidential client secret(s) in realm '${REALM}' — none is an unsubstituted \${...} literal."
exit 0
