#!/usr/bin/env bats
#
# POSITIVE CONTROL for scripts/checks/check_deploy_drift.sh.
#
# Ported from hill90-app's deploy-drift-control.bats (app#140, this repo's port
# is #705) — the CHECKOUT-only subset. This script deliberately does not carry
# hill90-app's later per-container revision comparison (their #158 and
# follow-ups); scope that up here if this repo grows the same "checkout is
# current, container is not" gap.
#
# An alarm nobody has SEEN FIRE is the same object as the checks that could not
# fire — so every case here builds a real repository, points the check at a
# deliberately stale deployment, and requires red. The green cases exist
# because an alarm that fires on everything gets muted, and a muted alarm is
# also one that cannot fire.
#
# Each fixture is a real git repository with real commits and real timestamps.
# Nothing is mocked: the check reads git, so the control gives it git.

CHECK="" # set in setup

# Commit with a controlled age. GIT_COMMITTER_DATE is what the check reads (%ct),
# and setting only AUTHOR_DATE would leave the committer date at now — a fixture
# that looks aged and is not, which is how a grace-window test passes for the
# wrong reason.
commit_at() {
    local hours_ago="$1" path="$2" msg="$3"
    local when
    when=$(( $(date +%s) - hours_ago * 3600 ))
    mkdir -p "$(dirname "$path")"
    echo "$RANDOM" > "$path"
    git add "$path"
    GIT_AUTHOR_DATE="@${when} +0000" GIT_COMMITTER_DATE="@${when} +0000" \
        git commit -qm "$msg"
}

setup() {
    CHECK="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/checks/check_deploy_drift.sh"
    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO"
    cd "$REPO"
    git init -q -b main .
    git config user.email t@example.com
    git config user.name t
    commit_at 200 "README.md" "base"
    # A local ref standing in for origin/main, so the fixture needs no network.
    git branch -f origin-main main
    export TARGET_REF=origin-main
    export LABEL=fixture
}

# ------------------------------------------------------------ CANNOT TELL ---
# These matter most. A check that cannot see the thing must not report green.

@test "no deployed SHA exits 2 and says nothing was compared — never a pass" {
    run env DEPLOYED_SHA= bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"UNKNOWN"* ]]
    [[ "$output" == *"NOT a pass"* ]]
}

@test "a deployed SHA this repo has never heard of exits 2, not 0" {
    run env DEPLOYED_SHA=0000000000000000000000000000000000000000 bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not a commit in this repository"* ]]
}

@test "an unresolvable target ref exits 2" {
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" TARGET_REF=origin/nope bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not resolve"* ]]
}

# --------------------------------------------------------- THE REAL ALARM ---

@test "FIRES: a deployable commit merged longer ago than the grace window" {
    # This is hill90-app's 2026-08-03 incident, replayed here: a platform/ fix
    # merged and not running, while every health check stays green because it
    # answers from the container that is running the old code.
    deployed=$(git rev-parse HEAD)
    commit_at 9 "platform/observability/prometheus/alerts.yml" "fix: a bad alert selector"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"DEPLOY DRIFT for fixture"* ]]
    [[ "$output" == *"a bad alert selector"* ]]
    [[ "$output" == *"9h"* ]]
}

@test "FIRES: the host carries a commit that is on no branch — reset will destroy it" {
    # The direction that is never normal. Someone edited production.
    commit_at 1 "platform/observability/hand-edit.yml" "hand edit made directly on the VPS"
    deployed=$(git rev-parse HEAD)
    git reset -q --hard origin-main

    run env DEPLOYED_SHA="$deployed" bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"HOST AHEAD"* ]]
    [[ "$output" == *"destroy them"* ]]
}

@test "the failing message is loud enough to act on without opening the repo" {
    deployed=$(git rev-parse HEAD)
    commit_at 30 "scripts/deploy.sh" "fix: the thing"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    # ::error:: so it surfaces in the Actions UI rather than only in the log body.
    [[ "$output" == *"::error::"* ]]
    [[ "$output" == *"fixture"* ]]
    [[ "$output" == *"Deploy, or say why not"* ]]
}

# ------------------------------------------------------ AND STAYS QUIET -----
# This repo's deploys are workflow_dispatch or path-filtered on push, not
# "every merge ships" — so drift is the NORMAL state between deploys, and an
# alarm that cannot be quiet here is one that gets muted.

@test "QUIET: checkout SHA equals the target" {
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"the host checkout matches"* ]]
}

@test "QUIET: old drift that touches only documentation" {
    deployed=$(git rev-parse HEAD)
    commit_at 100 "docs/decisions/whatever.md" "docs: a long essay"
    commit_at 90 "README.md" "docs: correct a date"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"not an outage"* ]]
}

@test "QUIET: a deployable commit merged minutes ago" {
    deployed=$(git rev-parse HEAD)
    commit_at 0 "scripts/backup.sh" "fix: something"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"inside the grace window"* ]]
}

@test "QUIET: a workflow-only change is never actionable, even old and merged alone" {
    # .github/workflows is deliberately outside DEPLOYABLE_PREFIXES: since the
    # app#139 port, the preflight runs the runner's copy, so a workflow change
    # is live the moment it is merged and never "undeployed" in the sense this
    # check means.
    deployed=$(git rev-parse HEAD)
    commit_at 100 ".github/workflows/deploy.yml" "ci: tweak a trigger"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
}

# ------------------------------------------------------------- the mixture --

@test "a docs commit NEWER than an aged deployable one does not reset the clock" {
    # The bug this pins: measuring the NEWEST undeployed commit would mean a busy
    # repository could never trip the alarm, because something always merged
    # recently. The oldest waiting deployable commit is the one that matters.
    deployed=$(git rev-parse HEAD)
    commit_at 48 "platform/data/postgres/init.sh" "fix: the security fix nobody deployed"
    commit_at 1  "docs/note.md" "docs: an unrelated note from an hour ago"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the security fix nobody deployed"* ]]
    [[ "$output" == *"48h"* ]]
}

@test "a docs commit OLDER than the grace window alone still does not fire" {
    # The mirror of the case above, so the filter is proven in both directions
    # rather than only where it happens to agree with the age rule.
    deployed=$(git rev-parse HEAD)
    commit_at 500 "README.md" "docs: ancient"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]
}

@test "CONTROL: the check is not vacuously green — it can be made to fire by one commit" {
    # Guards against the whole file passing because the script exits 0 early for
    # some unrelated reason. Same fixture, one deployable commit is the only
    # difference between green and red.
    deployed=$(git rev-parse HEAD)
    commit_at 50 "docs/only.md" "docs: only"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 0 ]

    commit_at 50 "scripts/checks/one.sh" "fix: one deployable change"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# THE WORDING IS PART OF THE CHECK.
#
# This alarm compares ONE git SHA read from the host against origin/main. It
# does not inspect a container image, and it must not print anything that
# could be read as a claim about running code — hill90-app's version made
# exactly that overclaim before its #162, and the wording tests there pinned
# the fix so it could not silently regress. This is the same shape, checked
# against a script that never had the overclaim to begin with — a control that
# proves it, not just a fixture that happens to pass.
# ---------------------------------------------------------------------------

@test "WORDING clean: says CHECKOUT, and never claims to know what is running" {
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"the host checkout matches"* ]]
    [[ "$output" != *"what is running is what was merged"* ]]
    [[ "$output" != *"is what was merged"* ]]
}

@test "WORDING clean: carries the NOT CHECKED caveat on every run, pass or fail" {
    # A green line with no stated limit reads as a broader guarantee than it is.
    # The caveat is printed in the scope banner, before any verdict, so it
    # travels with every outcome rather than living only in a comment.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [ "$status" -eq 0 ]
    [[ "$output" == *"NOT CHECKED"* ]]
    [[ "$output" == *"CONTAINER"* ]]

    deployed=$(git rev-parse HEAD)
    commit_at 9 "scripts/deploy.sh" "fix: a bound"
    git branch -f origin-main main
    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"NOT CHECKED"* ]]
}

@test "WORDING: the scope banner states the comparison before any verdict" {
    # A reader who stops at the first two lines must still not be able to infer
    # coverage that is absent.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [[ "$output" == *"SCOPE: compares the git CHECKOUT"* ]]
    scope_line=$(printf '%s\n' "$output" | grep -n "SCOPE:" | head -1 | cut -d: -f1)
    verdict_line=$(printf '%s\n' "$output" | grep -n "PASS:" | head -1 | cut -d: -f1)
    [ -n "$scope_line" ]
    [ -n "$verdict_line" ]
    [ "$scope_line" -lt "$verdict_line" ]
}

@test "WORDING drifted: says NOT IN THE HOST CHECKOUT, not 'not running'" {
    # The same overclaim with the opposite sign. The check knows the commits are
    # absent from the checkout; that they are not running follows, and the
    # message may say so — but the thing it VERIFIED must be named first.
    deployed=$(git rev-parse HEAD)
    commit_at 9 "scripts/checks/x.sh" "fix: a bound"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [ "$status" -eq 1 ]
    [[ "$output" == *"NOT IN THE HOST CHECKOUT"* ]]
    [[ "$output" == *"They are certainly not running"* ]]
}

@test "WORDING drifted: the count line is about the checkout too" {
    deployed=$(git rev-parse HEAD)
    commit_at 9 "scripts/checks/x.sh" "fix: a bound"
    git branch -f origin-main main

    run env DEPLOYED_SHA="$deployed" GRACE_HOURS=4 bash "$CHECK"
    [[ "$output" == *"not in the host checkout."* ]]
    [[ "$output" != *"merged and not deployed."* ]]
}

@test "WORDING unknown: names the checkout, and refuses to imply anything else" {
    run env DEPLOYED_SHA= bash "$CHECK"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no checkout SHA was supplied"* ]]
    [[ "$output" == *"nothing was compared"* ]]
}

@test "CONTROL: the wording assertions can fail — they are not matching everything" {
    # Every case above is a string match, and a string match that is always true
    # proves nothing. Each phrase pinned here is absent from a deliberately
    # different message.
    run env DEPLOYED_SHA="$(git rev-parse HEAD)" bash "$CHECK"
    [[ "$output" != *"NOT IN THE HOST CHECKOUT"* ]]
    [[ "$output" != *"no checkout SHA was supplied"* ]]
    [[ "$output" != *"verified the running image"* ]]
}
