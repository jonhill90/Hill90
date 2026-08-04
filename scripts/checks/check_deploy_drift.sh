#!/usr/bin/env bash
#
# Is the host's CHECKOUT the same as what was MERGED?
#
# NOT "is what is running the same as what was merged" — this compares one git
# SHA read from the host against origin/main. A deploy resets the whole
# checkout but rebuilds only the stacks that changed, so a running container
# can be older than the checkout reports. Ported from hill90-app's
# check_deploy_drift.sh, deliberately WITHOUT that repo's later per-container
# revision-stamp comparison (app#158 and its follow-ups) — this is the
# checkout-only version, matching that repo's own first cut. Scope it up if
# this repo grows the same gap between "checkout is current" and "container is
# current".
#
# WHY THIS EXISTS. On 2026-08-03, in hill90-app, a security fix was merged and
# did not reach production for 23 minutes because two defects in the deploy
# path each failed the deploy — and nothing anywhere said the fix was not
# running. It could not have: every health check answers from the running
# container, so they all report the OLD code as healthy — correctly. This
# repository has the identical deploy shape in five places (app#140, ported
# here as #705) and, before this file, nothing here compared deployed against
# merged either.
#
# WHY NOT SIMPLY `deployed != main`. This repo's deploys are workflow_dispatch
# or gated by path filters (deploy.yml), not "every merge ships" — so drift is
# the NORMAL state between deploys, and an alarm on any difference at all would
# be red most of the time and ignored inside a day.
#
# So it alarms on the difference that can actually hurt:
#
#   1. undeployed commits touching DEPLOYABLE paths — a docs commit that has
#      not shipped is not an outage, a platform/ or scripts/ commit that has
#      not shipped may be one;
#   2. that have been waiting longer than a grace window — a deploy takes
#      minutes and nobody deploys on every merge, so recent drift is expected;
#   3. or ANY commit on the host that is not on main — that direction is never
#      normal. It means someone edited production, and `git reset --hard` is
#      about to destroy it.
#
# THE THIRD EXIT CODE IS THE POINT. If the deployed SHA cannot be determined,
# this exits 2 and says so. It does not pass. An assertion that succeeds on
# absence is the failure mode this estate has hit repeatedly, most recently in
# `vault.sh assert-unsealed` — a check that cannot see the thing is not
# evidence the thing is fine.
#
# This runs on the RUNNER, against this repository's checkout, and is given the
# host's SHA as an input. It deliberately does NOT run from the host's copy:
# that is the bootstrap deadlock this same issue found in five workflows here
# (app#139's shape), where the guard is read from the very checkout it is
# meant to be judging.
#
# Usage:
#   DEPLOYED_SHA=<sha> bash scripts/checks/check_deploy_drift.sh
#
# Exit codes:
#   0  no actionable drift  (in sync, docs-only, or inside the grace window)
#   1  ACTIONABLE DRIFT     (deployable code merged and not running, or host ahead)
#   2  CANNOT DETERMINE     (no usable deployed SHA — never silent, never green)
#
# NOT CHECKED, DELIBERATELY: which commit a running CONTAINER was built from.
# A deploy resets the checkout but rebuilds one stack, so the checkout can be
# current while a service still runs older code. hill90-app's #158 is the
# record of that gap and its fix; porting it is future work, not this file's.

set -uo pipefail

DEPLOYED_SHA="${DEPLOYED_SHA:-}"
TARGET_REF="${TARGET_REF:-origin/main}"
GRACE_HOURS="${GRACE_HOURS:-4}"
LABEL="${LABEL:-Hill90}"

# Paths whose content is actually shipped to the host and executed there.
# .github/workflows is deliberately ABSENT: since the app#139 port, the deploy
# path runs the runner's copy of what matters for the preflight, so a workflow
# change is live the moment it is merged and can never be "undeployed" in the
# sense this check cares about.
DEPLOYABLE_PREFIXES="${DEPLOYABLE_PREFIXES:-platform/ deploy/compose/prod/ scripts/ infra/secrets/}"

say()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; }

say "Deploy drift — ${LABEL}"
say "=============================================="
say "  SCOPE: compares the git CHECKOUT on the host against ${TARGET_REF}."
say "  NOT CHECKED: which commit any running CONTAINER was built from."
say ""

# ---------------------------------------------------------------- unknown ---
if [ -z "$DEPLOYED_SHA" ]; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: no checkout SHA was supplied. This is NOT a pass — nothing was compared."
    exit 2
fi

if ! git rev-parse --verify --quiet "${DEPLOYED_SHA}^{commit}" >/dev/null; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: deployed SHA '${DEPLOYED_SHA}' is not a commit in this repository. The host may be on a branch that was force-pushed or deleted. Nothing was compared."
    exit 2
fi

if ! git rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
    fail "DEPLOY DRIFT UNKNOWN for ${LABEL}: '${TARGET_REF}' does not resolve. Fetch before running this."
    exit 2
fi

target_sha=$(git rev-parse "$TARGET_REF")
deployed_sha=$(git rev-parse "$DEPLOYED_SHA")

say "  host checkout: ${deployed_sha:0:12}"
say "  ${TARGET_REF}: ${target_sha:0:12}"
say ""

# ------------------------------------------------------------- host ahead ---
# Never normal. Commits that exist only on the host are undeployable by
# definition and `git reset --hard` destroys them silently.
ahead=$(git rev-list --count "${target_sha}..${deployed_sha}" 2>/dev/null || echo 0)
if [ "$ahead" -gt 0 ]; then
    fail "HOST AHEAD of ${TARGET_REF} for ${LABEL}: ${ahead} commit(s) exist on the deployed host and nowhere else. The next deploy's git reset --hard will destroy them."
    git --no-pager log --oneline -n 20 "${target_sha}..${deployed_sha}" | sed 's/^/    /'
    exit 1
fi

# ---------------------------------------------------------------- in sync ---
if [ "$deployed_sha" = "$target_sha" ]; then
    say "  PASS: the host checkout matches ${TARGET_REF}."
    exit 0
fi

behind=$(git rev-list --count "${deployed_sha}..${target_sha}")
say "  ${behind} commit(s) merged and not in the host checkout."

# --------------------------------------------------- deployable or not? ----
# shellcheck disable=SC2086
mapfile -t deployable < <(
    git rev-list "${deployed_sha}..${target_sha}" | while read -r sha; do
        files=$(git show --name-only --format="" "$sha")
        for prefix in $DEPLOYABLE_PREFIXES; do
            if printf '%s\n' "$files" | grep -q "^${prefix}"; then
                printf '%s\n' "$sha"
                break
            fi
        done
    done
)

if [ "${#deployable[@]}" -eq 0 ]; then
    say "  PASS: none of them touch a deployable path (${DEPLOYABLE_PREFIXES})."
    say "  Documentation and CI-only drift is not an outage. Reported, not alarmed."
    exit 0
fi

say "  ${#deployable[@]} of them touch deployable paths:"
for sha in "${deployable[@]}"; do
    git --no-pager log -1 --format='    %h %s' "$sha"
done
say ""

# ------------------------------------------------------------ grace window --
# The OLDEST undeployed deployable commit is the one that has waited longest.
# Measuring the newest would reset the clock every time anything merged, so a
# permanently-undeployed fix would stay inside the window forever as long as
# the repository stayed busy.
oldest_sha="${deployable[${#deployable[@]}-1]}"
oldest_epoch=$(git log -1 --format='%ct' "$oldest_sha")
now_epoch=$(date +%s)
age_hours=$(( (now_epoch - oldest_epoch) / 3600 ))

say "  oldest undeployed deployable commit is ${age_hours}h old (grace: ${GRACE_HOURS}h)"

if [ "$age_hours" -lt "$GRACE_HOURS" ]; then
    say "  PASS: inside the grace window."
    exit 0
fi

fail "DEPLOY DRIFT for ${LABEL}: ${#deployable[@]} commit(s) touching deployable paths have been merged for ${age_hours}h and are NOT IN THE HOST CHECKOUT. The oldest is $(git log -1 --format='%h %s' "$oldest_sha"). They are certainly not running. Deploy, or say why not."
exit 1
