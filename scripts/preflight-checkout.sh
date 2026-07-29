#!/usr/bin/env bash
# Checkout preflight — run on the VPS immediately BEFORE `git reset --hard`.
#
# WHY THIS EXISTS
#
# /opt/hill90/app is a deploy target that people hand-edit, and every deploy path
# in this repository runs `git reset --hard origin/main`. A local edit there is
# therefore destroyed silently, by design, with no record of what it was —
# unstaged changes are never written to git's object database, so there is no
# blob, no stash and no reflog entry to recover from.
#
# On 2026-07-29 exactly that happened: an uncommitted change to
# platform/edge/dynamic/middlewares.yml was discarded during a routine `git
# fetch && git reset --hard origin/main`, and its contents are gone permanently.
# The checkout had also been sitting 12 commits behind main for three days, so
# production config genuinely differed from the repository and nobody knew.
#
# THE PART THAT MAKES IT SERIOUS
#
# Some paths in this repository are bind-mounted into running containers, and one
# of them is *watched*. platform/edge/dynamic is mounted into Traefik at
# /etc/traefik/dynamic with `watch: true`, so editing a file there is
# simultaneously a LIVE production change and a doomed one. `git reset --hard`
# on that path rewrites edge security configuration on a running host, and
# Traefik reloads it within seconds.
#
# A dirty tree under docs/ is untidy. A dirty tree under platform/edge/dynamic is
# an undocumented live production change about to be reverted without review.
# This script distinguishes them.
#
# BEHAVIOUR
#
#   clean tree                -> report drift, exit 0
#   dirty tree                -> print the FULL diff, classify each path, exit 1
#   ALLOW_DIRTY_CHECKOUT=1    -> print the FULL diff, classify, exit 0
#
# The diff is printed in every case, including the override, because it is the
# only record that will survive the reset.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths that are bind-mounted into running containers.
#
# Derived from the `../../../<path>:` bind mounts in deploy/compose/prod/*.yml.
# Keep in step with those files; tests/scripts/preflight-checkout.bats pins the
# behaviour, not the list.
# ---------------------------------------------------------------------------

# Bind-mounted AND watched — an edit takes effect on a running container within
# seconds, with no restart and no deploy.
WATCHED_PATHS=(
    "platform/edge/dynamic"
)

# Bind-mounted — an edit is visible inside the container immediately and takes
# effect at its next restart.
BIND_MOUNTED_PATHS=(
    "platform/auth/keycloak/platform-realm.json"
    "platform/auth/keycloak/themes/hill90"
    "platform/data/postgres/init.sh"
    "platform/observability/grafana/provisioning"
    "platform/observability/loki/loki.yml"
    "platform/observability/prometheus/alerts.yml"
    "platform/observability/prometheus/prometheus.yml"
    "platform/observability/promtail/promtail.yml"
    "platform/observability/tempo/tempo.yml"
    "platform/vault/policies"
)

classify_path() {
    local path="$1" p
    for p in "${WATCHED_PATHS[@]}"; do
        case "$path" in "$p"|"$p"/*) printf 'LIVE (WATCHED — Traefik reloads this within seconds)'; return ;; esac
    done
    for p in "${BIND_MOUNTED_PATHS[@]}"; do
        case "$path" in "$p"|"$p"/*) printf 'BIND-MOUNTED (in-container now, active at next restart)'; return ;; esac
    done
    printf 'not mounted'
}

# ---------------------------------------------------------------------------
# Drift
# ---------------------------------------------------------------------------

report_drift() {
    local behind ahead
    git rev-parse --verify -q origin/main >/dev/null 2>&1 || {
        echo "  drift: origin/main not fetched — cannot determine"
        return 0
    }
    behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)

    if [ "$behind" -eq 0 ] && [ "$ahead" -eq 0 ]; then
        echo "  drift: up to date with origin/main"
        return 0
    fi

    echo ""
    echo "  ################################################################"
    echo "  # DRIFT: this checkout is ${behind} commits behind origin/main"
    [ "$ahead" -gt 0 ] && echo "  #        and ${ahead} commits ahead (unpushed local commits!)"
    echo "  #"
    echo "  # Production has been running config that differs from the"
    echo "  # repository. Commits not yet deployed:"
    echo "  ################################################################"
    git --no-pager log --oneline HEAD..origin/main 2>/dev/null | sed 's/^/    /' | head -20
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "=============================================="
echo "Checkout preflight — $(pwd)"
echo "=============================================="

report_drift

if [ -z "$(git status --porcelain)" ]; then
    echo "  working tree clean — safe to reset"
    exit 0
fi

echo ""
echo "  ################################################################"
echo "  # THE WORKING TREE IS DIRTY"
echo "  #"
echo "  # \`git reset --hard\` will destroy the changes below and they are"
echo "  # NOT RECOVERABLE — unstaged changes are not git objects, so there"
echo "  # is no stash, no blob and no reflog entry to restore from."
echo "  #"
echo "  # This diff is the only record. Copy it before continuing."
echo "  ################################################################"
echo ""

echo "  Modified paths, by how live they are:"
echo ""
live_count=0
while IFS= read -r line; do
    [ -n "$line" ] || continue
    path="${line:3}"
    class="$(classify_path "$path")"
    printf '    %-56s %s\n' "$path" "$class"
    case "$class" in LIVE*|BIND-MOUNTED*) live_count=$((live_count + 1)) ;; esac
done < <(git status --porcelain)

if [ "$live_count" -gt 0 ]; then
    echo ""
    echo "  *** ${live_count} of these are mounted into running containers. ***"
    echo "  *** An edit there was a live production change. Resetting it is"
    echo "  *** another one, in the opposite direction, with no review."
fi

echo ""
echo "  ---------------- FULL DIFF (tracked files) ----------------"
git --no-pager diff | sed 's/^/  /'
echo "  ---------------- END DIFF ----------------"
echo ""

untracked=$(git ls-files --others --exclude-standard)
if [ -n "$untracked" ]; then
    echo "  Untracked files (git reset --hard leaves these, but they are undeployed):"
    echo "$untracked" | sed 's/^/    /'
    echo ""
fi

if [ "${ALLOW_DIRTY_CHECKOUT:-0}" = "1" ]; then
    echo "  ALLOW_DIRTY_CHECKOUT=1 — proceeding and discarding the above."
    exit 0
fi

echo "  REFUSING to continue."
echo ""
echo "  Land the change in the repository, or re-run with"
echo "  ALLOW_DIRTY_CHECKOUT=1 if you genuinely mean to discard it."
exit 1
