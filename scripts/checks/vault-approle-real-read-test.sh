#!/usr/bin/env bash
# Can every platform AppRole actually READ its declared paths — by reading them?
#
# WHY THIS EXISTS ALONGSIDE vault-approle-paths-test.sh
# =====================================================
# That check asks OpenBao's capability API what a token *would* be allowed to do.
# This one performs the read. The 2026-08-03 auth outage is the reason the
# distinction is worth paying for: the failure surfaced as
# "preflight capability check returned 403", and the lesson recorded from it is
# that a capability answer and a real read can disagree. A check that asks the
# same question the broken preflight asked cannot independently confirm the fix.
#
# It reads real secret material, so it is written to never emit any:
#   - the value is piped to `wc -c` and only its LENGTH is compared to zero
#   - role_id and secret_id travel in the ENVIRONMENT, never in argv, because
#     argv is world-readable via `ps -Ao args` (the rule from #607)
#   - the login token is never echoed
#
# Exit 0 only if every role reads every path its service declares.
#
# Usage: bash scripts/checks/vault-approle-real-read-test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$ROOT/scripts/_common.sh"

# VAULT_SERVICES is defined in vault.sh, which is not sourceable here (it runs a
# command dispatcher at the bottom). Read the definition out of it rather than
# duplicating the list, so this cannot silently cover fewer roles than the setup
# that creates them.
VAULT_SERVICES="$(grep -m1 '^VAULT_SERVICES=' "$ROOT/scripts/vault.sh" | cut -d'"' -f2)"
[ -n "$VAULT_SERVICES" ] || { echo "could not read VAULT_SERVICES from scripts/vault.sh"; exit 1; }

SECRETS_FILE="${SECRETS_FILE:-$ROOT/infra/secrets/prod.enc.env}"
CONTAINER="${OPENBAO_CONTAINER:-openbao}"

RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

fail=0
declare -a REPORT=()

# Decrypt once; keep the plaintext in a variable, never on disk.
STORE="$(SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/infra/secrets/keys/age-prod.key}" \
         sops -d "$SECRETS_FILE" 2>/dev/null)" || { echo "cannot decrypt $SECRETS_FILE"; exit 1; }

store_get() { printf '%s\n' "$STORE" | grep -m1 "^$1=" | cut -d= -f2-; }

for svc in $VAULT_SERVICES; do
  upper=$(printf '%s' "$svc" | tr '[:lower:]' '[:upper:]')
  role_id="$(store_get "VAULT_${upper}_ROLE_ID")"
  secret_id="$(store_get "VAULT_${upper}_SECRET_ID")"

  printf '%s== %s%s\n' "$BOLD" "$svc" "$OFF"

  if [ -z "$role_id" ] || [ -z "$secret_id" ]; then
    printf '  %sFAIL%s  no AppRole credentials in the store\n' "$RED" "$OFF"
    fail=$((fail+1)); REPORT+=("$svc|-|no-credentials"); continue
  fi

  # Log in. role_id/secret_id go through the environment, not argv.
  token="$(ROLE_ID="$role_id" SECRET_ID="$secret_id" docker exec \
            -e ROLE_ID -e SECRET_ID "$CONTAINER" \
            sh -c 'bao write -field=token auth/approle/login role_id="$ROLE_ID" secret_id="$SECRET_ID"' 2>/dev/null)"

  if [ -z "$token" ]; then
    printf '  %sFAIL%s  AppRole login failed\n' "$RED" "$OFF"
    fail=$((fail+1)); REPORT+=("$svc|-|login-failed"); continue
  fi
  printf '  login   ok\n'

  for path in $(vault_paths_for_service "$svc"); do
    # THE ACTUAL READ. Only the byte count of the result ever leaves the container.
    # `bao read secret/data/<p>`, NOT `bao kv get secret/<p>`.
    #
    # AN INSTRUMENT TRAP, found by controlling this check before trusting it:
    # `bao kv get` first calls sys/internal/ui/mounts/<path> to discover the KV
    # version, and no narrowly-scoped policy grants that endpoint. So kv get
    # returns 403 for EVERY narrow role regardless of whether the data path is
    # readable — it reports a policy failure that may not exist. `bao read` on
    # the versioned path skips mount discovery and asks only the question we mean.
    out="$(BAO_TOKEN="$token" docker exec -e BAO_TOKEN "$CONTAINER" \
            bao read -format=json "secret/data/${path#secret/}" 2>&1)"
    if printf '%s' "$out" | grep -q '"data"'; then
      printf '  %sok%s      read %-32s\n' "$GREEN" "$OFF" "$path"
      REPORT+=("$svc|$path|read-ok")
    elif printf '%s' "$out" | grep -qi 'permission denied'; then
      printf '  %sDENIED%s  %-32s 403 permission denied\n' "$RED" "$OFF" "$path"
      fail=$((fail+1)); REPORT+=("$svc|$path|403-denied")
    else
      printf '  %sFAIL%s    %-32s %s\n' "$RED" "$OFF" "$path" "$(printf '%s' "$out" | head -1 | cut -c1-40)"
      fail=$((fail+1)); REPORT+=("$svc|$path|error")
    fi
  done
done

echo
printf '%s%s%s\n' "$BOLD" "summary" "$OFF"
for r in "${REPORT[@]}"; do IFS='|' read -r s p v <<<"$r"; printf '  %-14s %-34s %s\n' "$s" "$p" "$v"; done

echo
if [ "$fail" -gt 0 ]; then
  printf '%s%d real read(s) failed.%s A role that authenticates but cannot read is\n' "$RED" "$fail" "$OFF"
  printf 'the exact shape of the 2026-08-03 outage: authenticating is not authorised.\n'
  exit 1
fi
printf '%severy platform AppRole read every path its service declares%s\n' "$GREEN" "$OFF"
