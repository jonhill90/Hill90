#!/usr/bin/env bash
# Prove check_realm_secret_not_literal.sh (h#835) in every arm it claims to
# handle, against real disposable Keycloaks — never the VPS, never a shared
# stack. Same discipline as realm-tenant-serves-test.sh: build and destroy its
# own throwaway containers.
#
# Order matters and is deliberate: the FAILING arm runs first. A check that has
# only ever been shown a clean result has not been shown anything — this repo's
# own recurring lesson (h#736/h#758, the twin-drift bugs surfaced auditing this
# very issue) is that an unexercised or vacuous-pass check is indistinguishable
# from a working one until it is actually forced to fail.
#
# Usage: bash scripts/checks/realm-secret-substitution-test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$ROOT/scripts/checks/check_realm_secret_not_literal.sh"
IMG="quay.io/keycloak/keycloak:26.4.0"
ADMIN="admin"
# Disposable, for containers this script creates and destroys.
ADMIN_PW="throwaway-not-a-real-credential"

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
pass=0; fail=0
ok()  { echo -e "  ${GREEN}✓${NC} $1"; pass=$((pass+1)); }
bad() { echo -e "  ${RED}✗${NC} $1"; fail=$((fail+1)); }

FAIL_KC="h835test-fail-kc"
EMPTY_KC="h849test-empty-kc"
PASS_KC="h835test-pass-kc"
cleanup() { docker rm -f "$FAIL_KC" "$EMPTY_KC" "$PASS_KC" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

start_kc() {
    local name="$1"; shift
    docker run -d --name "$name" -P \
        -e KC_BOOTSTRAP_ADMIN_USERNAME="$ADMIN" \
        -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PW" \
        -e KC_HTTP_ENABLED=true \
        -e VAULT_OIDC_CLIENT_SECRET=throwaway-vault-secret \
        "$@" \
        -v "$ROOT/platform/auth/keycloak/platform-realm.json:/opt/keycloak/data/import/platform-realm.json:ro" \
        "$IMG" start-dev --import-realm >/dev/null
}

wait_ready() {
    local name="$1"
    for _ in $(seq 1 60); do
        # argv-ok: ADMIN_PW is the literal throwaway on line 21, in a
        # container this script creates and destroys — same pattern as
        # realm-tenant-serves-test.sh's own kcadm login.
        docker exec "$name" /opt/keycloak/bin/kcadm.sh config credentials \
            --server http://127.0.0.1:8080 --realm master \
            --user "$ADMIN" --password "$ADMIN_PW" >/dev/null 2>&1 && return 0
        sleep 2
    done
    return 1
}

echo -e "${BOLD}Arm 1 (THE CASE THAT MATTERS, run first): import with HILL90_UI_CLIENT_SECRET UNSET${NC}"
start_kc "$FAIL_KC"
if wait_ready "$FAIL_KC"; then
    out=$(bash "$CHECK" "$FAIL_KC" platform "$ADMIN" "$ADMIN_PW" 2>&1); code=$?
    if [ "$code" -eq 1 ] && echo "$out" | grep -q "PLACEHOLDER FOUND: client 'hill90-ui'"; then
        ok "refused: exit 1, named hill90-ui and the literal placeholder"
    else
        bad "expected exit 1 naming hill90-ui's placeholder, got exit ${code}: $out"
    fi
else
    bad "fail-arm Keycloak never became ready — could not run this arm at all"
fi
docker rm -f "$FAIL_KC" >/dev/null 2>&1

echo ""
echo -e "${BOLD}Arm 1b (h#849, THE CASE THE ORIGINAL CHECK MISSED): import with HILL90_UI_CLIENT_SECRET SET TO EMPTY STRING${NC}"
# Empty and unset are NOT the same failure at the Keycloak API level, verified
# live: an EMPTY value produces exit 0 with empty output from the
# /client-secret endpoint — byte-identical to a client that genuinely has no
# secret credential at all. The first version of this check treated both as
# "nothing to check" and returned PASS against this exact case, even though
# its own message already claimed to cover "unset OR EMPTY".
start_kc "$EMPTY_KC" -e HILL90_UI_CLIENT_SECRET=
if wait_ready "$EMPTY_KC"; then
    out=$(bash "$CHECK" "$EMPTY_KC" platform "$ADMIN" "$ADMIN_PW" 2>&1); code=$?
    if [ "$code" -eq 1 ] && echo "$out" | grep -q "EMPTY SECRET: client 'hill90-ui'"; then
        ok "refused: exit 1, named hill90-ui and EMPTY (not the placeholder message)"
    else
        bad "expected exit 1 naming hill90-ui's empty secret, got exit ${code}: $out"
    fi
else
    bad "empty-arm Keycloak never became ready — could not run this arm at all"
fi
docker rm -f "$EMPTY_KC" >/dev/null 2>&1

echo ""
echo -e "${BOLD}Arm 2: import with HILL90_UI_CLIENT_SECRET SET — must pass, and for the RIGHT reason${NC}"
start_kc "$PASS_KC" -e HILL90_UI_CLIENT_SECRET=real-tenant-ui-secret-0123456789
if wait_ready "$PASS_KC"; then
    out=$(bash "$CHECK" "$PASS_KC" platform "$ADMIN" "$ADMIN_PW"); code=$?
    if [ "$code" -eq 0 ] && echo "$out" | grep -q "checked 2 confidential client secret"; then
        ok "passed: exit 0, both confidential clients (hill90-ui, hill90-vault) checked"
    else
        bad "expected exit 0 having checked 2 clients, got exit ${code}: $out"
    fi
else
    bad "pass-arm Keycloak never became ready — could not run this arm at all"
fi

echo ""
echo -e "${BOLD}Arm 3: CANNOT DETERMINE must be distinct from PASS, in every way it can arise${NC}"

out=$(bash "$CHECK" h835test-does-not-exist platform "$ADMIN" "$ADMIN_PW" 2>&1); code=$?
[ "$code" -eq 2 ] && echo "$out" | grep -q "CANNOT DETERMINE.*does not exist" \
    && ok "unreachable container: exit 2, not exit 0" \
    || bad "unreachable container did not produce CANNOT DETERMINE: exit ${code}: $out"

out=$(bash "$CHECK" "$PASS_KC" platform "$ADMIN" "wrong-password" 2>&1); code=$?
[ "$code" -eq 2 ] && echo "$out" | grep -q "CANNOT DETERMINE.*login failed" \
    && ok "bad admin credentials: exit 2, not exit 0" \
    || bad "bad admin credentials did not produce CANNOT DETERMINE: exit ${code}: $out"

docker exec "$PASS_KC" /opt/keycloak/bin/kcadm.sh create realms -s realm=h835test-empty -s enabled=true >/dev/null 2>&1
out=$(bash "$CHECK" "$PASS_KC" h835test-empty "$ADMIN" "$ADMIN_PW" 2>&1); code=$?
[ "$code" -eq 2 ] && echo "$out" | grep -q "no confidential client has a secret key at all" \
    && ok "a realm with no real client secret to check: exit 2 (THE TRAP — this must never read as a pass)" \
    || bad "an empty/no-secret realm did not produce CANNOT DETERMINE: exit ${code}: $out"

out=$(bash "$CHECK" "$PASS_KC" nonexistent-realm-xyz "$ADMIN" "$ADMIN_PW" 2>&1); code=$?
[ "$code" -eq 2 ] && echo "$out" | grep -q "client list query for realm 'nonexistent-realm-xyz' failed" \
    && ok "a failed client-list query (bad realm): exit 2, not exit 0" \
    || bad "a failed client-list query did not produce CANNOT DETERMINE: exit ${code}: $out"

echo ""
if [ "$fail" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All ${pass} assertions passed.${NC}"; exit 0
fi
echo -e "${RED}${BOLD}${fail} failed, ${pass} passed.${NC}"; exit 1
