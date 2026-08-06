#!/usr/bin/env bash
# Do any MinIO policy names collide with realm roles that grant themselves?
#
# WHY THIS IS A REAL HAZARD AND NOT A STYLE RULE
# ==============================================
# MinIO reads a claim (minio_policy) and grants the policies NAMED in it. The
# Keycloak mapper is a realm-role mapper, so the claim is the user's realm roles.
# Measured against RELEASE.2025-09-07T16-13-09Z on 2026-08-03:
#
#   * values naming no policy are IGNORED
#   * values naming policies are UNIONED
#   * if nothing matches, STS refuses
#
# Every user in realm `platform` automatically holds offline_access,
# uma_authorization and default-roles-platform. **A MinIO policy named after any
# of those is granted to every user who can log in**, silently, with no role
# assignment anywhere. Demonstrated: policies called uma_authorization and
# offline_access gave jon list and write purely for being a realm member.
#
# So this checks the intersection of two lists that live in different systems and
# are never otherwise compared.
#
# It also WARNS about policies named after realm roles that exist with zero
# holders — the Stage-0 legacy names, read from keycloak.sh's own
# REALM_ROLES_REMOVED (h#776) rather than restated here, for the same reason
# check_retired_roles_ungranted.py already reads it that way: hardcoding a
# second copy of that list is how it goes stale the next time a role is
# retired. It already had: this loop was `admin editor viewer`, silently
# missing `user` after REALM_ROLES_REMOVED grew a fourth name — found by
# sibling-comparing this file against check_retired_roles_ungranted.py,
# which sources the same list correctly and so never missed it.
#
# Reads names only. No policy body, no secret, no token is printed.
#
# Usage: bash scripts/checks/minio-policy-names-test.sh
# Exit:  0 no universal-role collisions | 1 collision found | 2 could not
#        determine (MinIO/Keycloak unreachable, credentials unavailable, or
#        the policy list could not be read) — h#776: previously exit 1,
#        indistinguishable from a genuine collision on exit code alone.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEYCLOAK_SH="${SCRIPT_DIR}/../keycloak.sh"

MINIO_CONTAINER="${MINIO_CONTAINER:-minio}"
KC_CONTAINER="${KC_CONTAINER:-keycloak}"
KC_REALM="${KC_REALM:-platform}"
SECRETS_FILE="${MINIO_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"

# Roles Keycloak grants automatically to every account in the realm. A policy
# named after one of these is a grant to everybody.
UNIVERSAL_ROLES="offline_access uma_authorization default-roles-${KC_REALM}"

echo "MinIO policy names vs Keycloak realm roles"
echo "=========================================="

docker inspect "$MINIO_CONTAINER" >/dev/null 2>&1 || { echo "MinIO container not running — cannot determine, not proven clean" >&2; exit 2; }

ROOT_USER=$(sops -d "$SECRETS_FILE" 2>/dev/null | sed -n 's/^MINIO_ROOT_USER=//p' | head -1)
ROOT_PASS=$(sops -d "$SECRETS_FILE" 2>/dev/null | sed -n 's/^MINIO_ROOT_PASSWORD=//p' | head -1)
[ -n "$ROOT_USER" ] && [ -n "$ROOT_PASS" ] || { echo "MinIO root credentials unavailable — cannot determine, not proven clean" >&2; exit 2; }

POLICIES=$(MC_HOST_local="http://${ROOT_USER}:${ROOT_PASS}@127.0.0.1:9000" \
    docker exec -e MC_HOST_local "$MINIO_CONTAINER" mc admin policy ls local 2>/dev/null | tr -d '\r')
[ -n "$POLICIES" ] || { echo "Could not list MinIO policies — cannot determine, not proven clean" >&2; exit 2; }

echo "  MinIO policies: $(printf '%s' "$POLICIES" | tr '\n' ' ')"
echo

FAIL=0

echo "Universal realm roles — a policy with these names grants EVERY user:"
for role in $UNIVERSAL_ROLES; do
    if printf '%s\n' "$POLICIES" | grep -qx "$role"; then
        echo "  ✗ COLLISION: policy '${role}' is granted to every account in realm ${KC_REALM}"
        FAIL=1
    else
        echo "  ✓ no policy named ${role}"
    fi
done

# Zero-holder legacy names: a warning, not a failure. Needs Keycloak; skip
# cleanly if it is unavailable rather than reporting a false all-clear.
echo
echo "Legacy role-named policies (over-grant if the role is ever assigned):"
if docker inspect "$KC_CONTAINER" >/dev/null 2>&1; then
    LEGACY_ROLES=$(sed -n 's/^REALM_ROLES_REMOVED="\([^"]*\)"/\1/p' "$KEYCLOAK_SH" | head -1)
    if [ -z "$LEGACY_ROLES" ]; then
        echo "  (REALM_ROLES_REMOVED could not be read from ${KEYCLOAK_SH} — not checked, which is not the same as clear)"
    else
        for legacy in $LEGACY_ROLES; do
            printf '%s\n' "$POLICIES" | grep -qx "$legacy" \
                && echo "  ! policy '${legacy}' exists and is named after a realm role — unreachable only while that role has zero holders"
        done
    fi
else
    echo "  (Keycloak container absent — not checked, which is not the same as clear)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "NO UNIVERSAL-ROLE COLLISIONS."
else
    echo "COLLISION — a policy is named after a role every user holds. Rename or remove it."
fi
exit "$FAIL"
