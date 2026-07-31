#!/usr/bin/env bash
# Refuse credentials passed as command-line arguments.
#
# WHY
#
# A process's argv is world-readable. `ps -Ao args` shows it to every local user
# on the host, so `docker exec -e "BAO_TOKEN=$token" ...` publishes the vault
# root token to anyone with a shell. Demonstrated rather than assumed, with a
# dummy value:
#
#   $ ps -Ao args | grep '^docker exec'
#   docker exec -e PSPROBE=<the value is right here> ... sleep 10
#
# The safe form is `-e NAME` with NO value: docker passes the variable through
# from its own environment, so the value is never an argument. scripts/keycloak.sh
# used that from the start and said why; scripts/vault.sh and scripts/_common.sh
# did not, which is what this check now prevents from coming back.
#
# This is the shell analogue of a token in a query string: the credential is
# correct, the transport publishes it.
#
# WHY A GREP AND NOT A CENTRAL MECHANISM
#
# Shell has no single logger to wrap. What it does have is a small number of
# shared helpers — bao_exec_env, vault_read_kv, kc_login — through which almost
# every credential-bearing call already flows. Those are the mechanism; this
# check is the tripwire for the call that does not use them.
#
# ESCAPE HATCH
#
# A throwaway credential in a disposable test container is not an exposure. Mark
# such a line with `# argv-ok: <reason>` on the line itself or the line above.
# The marker is deliberately ugly so it is noticed in review.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2

SECRET_NAME='[A-Z_]*(TOKEN|PASSWORD|PASSWD|SECRET|KEY|CREDENTIAL|_PW)'
FILES=$(git ls-files 'scripts/*.sh' 'scripts/**/*.sh' '.github/workflows/*.yml' 2>/dev/null)

fail=0

report() {
    local file="$1" line="$2" rule="$3" text="$4"
    # Print the RULE and the location, and only a shape-safe slice of the line:
    # everything after the first '=' of the offending assignment is elided, so
    # this check can never itself print a credential.
    local safe
    safe=$(printf '%s' "$text" | sed -E "s/(-e +\"?${SECRET_NAME}=)[^\" ]*/\\1<ELIDED>/g; s/((--new-password|--password|-u) +)[^ ]*/\\1<ELIDED>/g" | cut -c1-140)
    echo "  ${file}:${line}"
    echo "     rule: ${rule}"
    echo "     line: ${safe}"
    fail=1
}

has_marker() {
    # The marker may be on the line itself, or anywhere in the CONTIGUOUS comment
    # block immediately above it. Walking the block beats a fixed lookback: a
    # two-line justification defeated a three-line window, and silently ignoring
    # a correctly written marker is the worst behaviour this check could have.
    local file="$1" line="$2" i text
    awk -v n="$line" 'NR==n' "$file" 2>/dev/null | grep -q 'argv-ok:' && return 0
    i=$(( line - 1 ))
    while [ "$i" -ge 1 ]; do
        text=$(awk -v n="$i" 'NR==n' "$file" 2>/dev/null)
        # Stop at the first line that is neither a comment nor a continuation of
        # the statement being flagged.
        case "$text" in
            *'argv-ok:'*) return 0 ;;
            '#'*|' '*'#'*|$'	'*'#'*) i=$(( i - 1 )) ;;
            *'\') i=$(( i - 1 )) ;;
            *) return 1 ;;
        esac
    done
    return 1
}

echo "Checking for credentials passed in argv..."

for f in $FILES; do
    [ -f "$f" ] || continue

    # Rule 1: docker -e NAME=<expansion> where NAME looks like a secret.
    while IFS=: read -r ln text; do
        [ -z "${ln:-}" ] && continue
        has_marker "$f" "$ln" && continue
        report "$f" "$ln" "secret value in argv: use \`VAR=\$v docker exec -e VAR\` (name only)" "$text"
    done < <(grep -nE -- "-e +\"?${SECRET_NAME}=[^\"]*(\\\$|\\\$\\{\\{)" "$f" 2>/dev/null | grep -vE '^[0-9]+: *#')

    # Rule 2: a password/user flag taking an expansion.
    while IFS=: read -r ln text; do
        [ -z "${ln:-}" ] && continue
        has_marker "$f" "$ln" && continue
        report "$f" "$ln" "credential flag in argv: pass it through the environment instead" "$text"
    # `-u` is deliberately NOT matched generically: `shred -u`, `sort -u` and
    # friends made it pure noise. curl's form is matched explicitly instead.
    done < <(grep -nE -- '(--password|--new-password|--bao-token) +"?\$|curl[^|]* -u +"?\$' "$f" 2>/dev/null | grep -vE '^[0-9]+: *#')
done

echo ""
if [ "$fail" -eq 0 ]; then
    echo "No credentials found in command-line arguments."
else
    echo "Credentials in argv are readable by any local user via \`ps\`."
    echo "Fix, or mark a genuine throwaway with '# argv-ok: <reason>'."
fi
exit "$fail"
