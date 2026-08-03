#!/usr/bin/env bash
# Do the four platform AppRoles still authenticate against OpenBao?
#
# WHY THIS IS A SEPARATE CHECK
# ============================
# AppRole and OIDC are INDEPENDENT auth methods. Proving one says nothing about
# the other, and that is not a hypothetical: on 2026-08-02 the vault had four
# working AppRoles and no OIDC method at all, which is exactly the shape that
# reads as "the vault is fine". Anything that touches vault auth re-runs this
# afterwards.
#
# It also answers #639's question — "are the stored AppRole credentials
# rejected?" — with a command instead of a memory.
#
# Reads the credentials from SOPS. Nothing is printed but the role name, the
# outcome and the policies attached; no role_id, secret_id or token value ever
# reaches stdout, a log, or argv.
#
# Usage: bash scripts/checks/vault-approle-login-test.sh
# Exit:  0 all four authenticate | 1 any failure

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONTAINER="${VAULT_CONTAINER:-openbao}"
SECRETS_FILE="${VAULT_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"
SERVICES="${VAULT_SERVICES:-db auth infra observability}"

command -v sops >/dev/null 2>&1 || { echo "sops is required" >&2; exit 1; }
[ -f "$SECRETS_FILE" ] || { echo "Secrets file not found: $SECRETS_FILE" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "Container $CONTAINER is not running" >&2; exit 1; }

# One decrypt, not two per service: sops is slow and each call is a chance to
# leave a plaintext copy somewhere.
PLAIN="$(sops -d "$SECRETS_FILE" 2>/dev/null)" || { echo "Could not decrypt $SECRETS_FILE" >&2; exit 1; }

field() { printf '%s\n' "$PLAIN" | grep "^${1}=" | cut -d= -f2- | head -1; }

echo "OpenBao AppRole login — the four platform roles"
echo "==============================================="

FAIL=0
for svc in $SERVICES; do
    U=$(printf '%s' "$svc" | tr '[:lower:]' '[:upper:]')
    RID=$(field "VAULT_${U}_ROLE_ID")
    SID=$(field "VAULT_${U}_SECRET_ID")

    if [ -z "$RID" ] || [ -z "$SID" ]; then
        printf '  ✗ %-15s credentials MISSING from SOPS\n' "$svc"
        FAIL=1
        continue
    fi

    # Credentials travel in the environment, never in argv — `docker exec -e NAME`
    # with no value passes the variable through without it entering the process
    # table. scripts/vault.sh documents why; this follows it.
    TOKEN=$(ROLE_ID="$RID" SECRET_ID="$SID" docker exec \
        -e BAO_ADDR=http://127.0.0.1:8200 -e ROLE_ID -e SECRET_ID "$CONTAINER" \
        sh -c 'bao write -field=token auth/approle/login role_id=$ROLE_ID secret_id=$SECRET_ID' 2>/dev/null)

    if [ -z "$TOKEN" ]; then
        printf '  ✗ %-15s LOGIN FAILED\n' "$svc"
        FAIL=1
        continue
    fi

    POLICIES=$(BAO_TOKEN="$TOKEN" docker exec \
        -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN "$CONTAINER" \
        bao token lookup -format=json 2>/dev/null \
        | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin)["data"]["policies"]))' 2>/dev/null)
    unset TOKEN

    if [ -z "$POLICIES" ]; then
        printf '  ✗ %-15s logged in but the token does not look up\n' "$svc"
        FAIL=1
        continue
    fi

    printf '  ✓ %-15s policies: %s\n' "$svc" "$POLICIES"
done
unset PLAIN

echo
if [ "$FAIL" -eq 0 ]; then
    echo "ALL APPROLES AUTHENTICATE"
else
    echo "APPROLE FAILURES — see above. Regenerate with vault.sh bootstrap-approles."
fi
exit "$FAIL"
