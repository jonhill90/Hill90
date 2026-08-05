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

# h#731: a docker-exec/connection failure used to read identically to a
# genuinely absent path — `2>/dev/null` discarded the difference, and empty
# stdout from EITHER cause printed the same "ABSENT" line. Verified against
# a real ghcr.io/openbao/openbao:2.6.1 container (the pinned production
# version) that a genuinely missing path and a real connection refusal
# (the "openbao mid-restart" scenario this issue names) return the SAME
# exit code, 2, from `bao` itself — only the stderr TEXT differs
# ("No value found at ..." vs "dial tcp ... connection refused"), so text is
# what this now checks, not the exit code. A docker exec failing outright
# (container not running) is a third real case, distinguishable the same
# way: empty stdout, a docker-daemon error on stderr containing neither.
VAULT_KEYS_ERR="$(mktemp)"
trap 'rm -f "$VAULT_KEYS_ERR"' EXIT

vault_keys() {  # path -> key NAMES on stdout, one per line. Values never leave the pipe.
    # Return: 0 = success (keys on stdout). 1 = GENUINELY ABSENT (bao's own
    # distinct "No value found at" message). 2 = CANNOT DETERMINE — anything
    # else (docker exec failing outright, a connection refusal, or any other
    # error) — must not be reported the same as absent.
    local raw
    : > "$VAULT_KEYS_ERR"
    raw="$(BAO_TOKEN="$BAO_TOKEN" docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN \
        "$CONTAINER" bao read -format=json "secret/data/${1#secret/}" 2>"$VAULT_KEYS_ERR")"
    if [ -z "$raw" ]; then
        if grep -q "No value found at" "$VAULT_KEYS_ERR"; then
            return 1
        fi
        return 2
    fi
    printf '%s' "$raw" | python3 -c '
import sys,json
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
undetermined_paths=()
echo "${BOLD}Per-path key parity (names only)${OFF}"
for p in $PATHS; do
    keys="$(vault_keys "$p")"
    rc=$?
    if [ "$rc" -eq 2 ]; then
        # CANNOT DETERMINE, not ABSENT — see vault_keys()'s own comment.
        # Printed distinctly and counted separately so it can never be read
        # as "checked and clean" OR silently folded into a real absence.
        err="$(cat "$VAULT_KEYS_ERR" 2>/dev/null)"
        printf '  %sCANNOT DETERMINE%s %-25s %s\n' "$YEL" "$OFF" "$p" "${err:-(no error output captured)}"
        undetermined_paths+=("$p"); continue
    fi
    if [ "$rc" -eq 1 ] || [ -z "$keys" ]; then
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
if [ "${#undetermined_paths[@]}" -gt 0 ]; then
    printf '%s%d canonical path(s) could not be read at all:%s %s\n' \
        "$YEL" "${#undetermined_paths[@]}" "$OFF" "${undetermined_paths[*]}"
fi
if [ "$fail" -gt 0 ]; then
    printf '%s%d parity problem(s).%s\n' "$RED" "$fail" "$OFF"
    exit 1
fi
if [ "${#undetermined_paths[@]}" -gt 0 ]; then
    # NOT a pass. Some paths were never actually read — "every canonical
    # path exists" would be a claim this run did not establish, exactly the
    # h#731 hazard in the other direction: a transient failure must not
    # silently disappear into a clean-looking result either.
    printf '%sCANNOT DETERMINE: %d path(s) could not be read — this run does NOT confirm parity for them.%s\n' \
        "$YEL" "${#undetermined_paths[@]}" "$OFF"
    exit 2
fi
printf '%severy canonical path exists and every vault key name is backed by SOPS%s\n' "$GREEN" "$OFF"
