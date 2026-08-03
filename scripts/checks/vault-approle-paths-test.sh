#!/usr/bin/env bash
# Can every platform AppRole actually READ the paths its service declares?
#
# WHY THIS IS DIFFERENT FROM vault-approle-login-test.sh
# ======================================================
# That check asks "does the AppRole authenticate". All four did, all through the
# 2026-08-03 auth outage — while the `auth` role could not read a single one of
# its paths. **Authenticating is not being authorised**, and the difference is
# exactly what took SSO down: `cmd_setup` attaches `token_policies=policy-<svc>`
# for every service, but `cmd_policy_apply` only writes the .hcl files that exist
# in platform/vault/policies/. There is no policy-auth.hcl and no policy-db.hcl,
# so those roles carry a policy that does not exist and are denied everything.
#
# The declared paths come from vault_paths_for_service() in _common.sh — the same
# function the deploy uses — so this cannot drift from what deploy actually asks
# for.
#
# Reads nothing but capability metadata. No secret value is fetched or printed.
#
# Usage: bash scripts/checks/vault-approle-paths-test.sh
# Exit:  0 every declared path is readable by its role | 1 any gap

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../_common.sh"

CONTAINER="${VAULT_CONTAINER:-openbao}"
SECRETS_FILE="${VAULT_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"
SERVICES="${VAULT_SERVICES:-db auth infra observability}"

echo "OpenBao AppRole authorisation — declared paths vs actual capability"
echo "==================================================================="
echo

FAIL=0
for svc in $SERVICES; do
    paths=$(vault_paths_for_service "$svc")
    if [ -z "$paths" ]; then
        printf '  %-15s declares no vault paths — nothing to check\n' "$svc"
        continue
    fi

    token=$(vault_login "$svc" "$SECRETS_FILE" 2>/dev/null)
    if [ -z "$token" ]; then
        printf '  %-15s ✗ AppRole LOGIN failed\n' "$svc"
        FAIL=1
        continue
    fi

    for path in $paths; do
        # KV v2 reads go through the /data/ prefix; the capability lives there.
        data_path="${path/secret\//secret/data/}"
        caps=$(BAO_TOKEN="$token" docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e BAO_TOKEN \
            "$CONTAINER" bao token capabilities "$data_path" 2>&1 | head -1)
        case "$caps" in
            *read*) printf '  %-15s ✓ %-32s %s\n' "$svc" "$path" "$caps" ;;
            *)      printf '  %-15s ✗ %-32s %s\n' "$svc" "$path" "$caps"
                    FAIL=1 ;;
        esac
    done
    unset token
done

echo
if [ "$FAIL" -eq 0 ]; then
    echo "EVERY DECLARED PATH IS READABLE — the vault-first path can work for all services."
else
    cat <<'MSG'
AUTHORISATION GAPS FOUND.

A denied path is not fatal to a deploy — scripts/_common.sh now fails the vault
load and deploy.sh falls back to SOPS — but it means the vault-first path is
DEAD for that service and every deploy of it is silently running on the fallback.

Fix is one of:
  * add the missing platform/vault/policies/policy-<svc>.hcl and re-apply, or
  * stop declaring the path in vault_paths_for_service() if vault is not meant
    to hold it.
Do not close the gap by loosening an existing policy to cover another service.
MSG
fi
exit "$FAIL"
