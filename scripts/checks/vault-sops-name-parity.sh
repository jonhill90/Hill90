#!/usr/bin/env bash
# What is in the vault, and what is in SOPS — by NAME, never by value.
#
#   BAO_TOKEN=... bash scripts/checks/vault-sops-name-parity.sh
#
# #650 asks the question this answers: "compare SOPS against vault, names only,
# to find anything else the re-seed dropped". It is deliberately a separate
# question from #661's, which was about two specific paths.
#
# NAMES ONLY, AND THAT IS ENFORCED BY CONSTRUCTION, not by care: every read is
# piped straight into a key extractor and the values are never bound to a
# variable, printed, or written. What this can tell you is which KEYS exist on
# each side. It cannot tell you whether their values agree, and it must not —
# that comparison would require both plaintexts in one place.
#
# AN AUTHENTICATED READ, ALWAYS. An unauthenticated `bao` command returns empty
# output, and empty output from a missing token is indistinguishable from empty
# output from a missing secret. This script refuses to run without a token
# rather than report an absence it cannot see.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$ROOT/scripts/_common.sh"

CONTAINER="${OPENBAO_CONTAINER:-openbao}"
SECRETS_FILE="${SECRETS_FILE:-$ROOT/infra/secrets/prod.enc.env}"

[ -n "${BAO_TOKEN:-}" ] || {
    echo "BAO_TOKEN is required. Without it every read returns empty, and an empty"
    echo "result would be reported as a missing secret when it is a missing token."
    exit 2
}

RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

# The canonical paths, taken from vault.sh rather than restated here so this
# cannot drift from what the seed writes.
PATHS=$(sed -n '/^cmd_export()/,/^}/p' "$ROOT/scripts/vault.sh" | grep -oE 'secret/[a-z/]+' | sort -u)
[ -n "$PATHS" ] || { echo "could not read the canonical path list from scripts/vault.sh"; exit 1; }

# --- names on each side ------------------------------------------------------

# Authenticated LIST of the mount. Proves which paths exist, as distinct from
# which paths we happened to ask about.
echo "${BOLD}Mount contents (authenticated list)${OFF}"
for top in $(BAO_TOKEN="$BAO_TOKEN" docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN \
                "$CONTAINER" bao list -format=json secret/metadata 2>/dev/null \
              | python3 -c 'import sys,json;print("\n".join(json.load(sys.stdin)))' 2>/dev/null); do
    printf '  %s\n' "secret/${top}"
    BAO_TOKEN="$BAO_TOKEN" docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN \
        "$CONTAINER" bao list -format=json "secret/metadata/${top%/}" 2>/dev/null \
      | python3 -c 'import sys,json
try:
    [print("    " + x) for x in json.load(sys.stdin)]
except Exception:
    pass' 2>/dev/null
done
echo

vault_keys() {  # path -> key NAMES, one per line. Values never leave the pipe.
    BAO_TOKEN="$BAO_TOKEN" docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN \
        "$CONTAINER" bao read -format=json "secret/data/${1#secret/}" 2>/dev/null \
      | python3 -c 'import sys,json
try:
    print("\n".join(sorted(json.load(sys.stdin)["data"]["data"])))
except Exception:
    pass'
}

sops_keys() {   # SOPS key NAMES only — cut at the first = and discard the rest.
    SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/infra/secrets/keys/age-prod.key}" \
        sops -d "$SECRETS_FILE" 2>/dev/null | grep -oE '^[A-Z0-9_]+' | sort -u
}

SOPS_NAMES="$(sops_keys)"
[ -n "$SOPS_NAMES" ] || { echo "could not decrypt $SECRETS_FILE"; exit 1; }
echo "${BOLD}SOPS${OFF} holds $(printf '%s\n' "$SOPS_NAMES" | wc -l | tr -d ' ') key names"
echo

# --- the comparison ----------------------------------------------------------

fail=0
missing_paths=()
echo "${BOLD}Per-path key parity (names only)${OFF}"
for p in $PATHS; do
    keys="$(vault_keys "$p")"
    if [ -z "$keys" ]; then
        printf '  %sABSENT%s  %-34s not present on the vault\n' "$RED" "$OFF" "$p"
        missing_paths+=("$p"); fail=$((fail+1)); continue
    fi
    n=$(printf '%s\n' "$keys" | wc -l | tr -d ' ')
    printf '  %sok%s      %-34s %s key(s)\n' "$GREEN" "$OFF" "$p" "$n"
    while IFS= read -r k; do
        [ -z "$k" ] && continue
        if ! printf '%s\n' "$SOPS_NAMES" | grep -qx "$k"; then
            printf '            %s%s%s is in the vault but NOT in SOPS — nothing backs it up\n' "$YEL" "$k" "$OFF"
            fail=$((fail+1))
        fi
    done <<<"$keys"
done

echo
if [ "${#missing_paths[@]}" -gt 0 ]; then
    printf '%s%d canonical path(s) absent from the vault:%s %s\n' \
        "$RED" "${#missing_paths[@]}" "$OFF" "${missing_paths[*]}"
fi
if [ "$fail" -gt 0 ]; then
    printf '%s%d parity problem(s).%s\n' "$RED" "$fail" "$OFF"
    exit 1
fi
printf '%severy canonical path exists and every vault key name is backed by SOPS%s\n' "$GREEN" "$OFF"
