#!/usr/bin/env bats

# Tests for scripts/preflight-checkout.sh
#
# Why this guard exists. /opt/hill90/app is a deploy target that people hand-edit,
# and every deploy path runs `git reset --hard origin/main`, so a local edit there
# is destroyed silently. On 2026-07-29 that happened: an uncommitted change to
# platform/edge/dynamic/middlewares.yml was discarded with nobody ever seeing the
# diff. That directory is bind-mounted into Traefik with `watch: true`, so an edit
# there is simultaneously a LIVE production change and a doomed one.
#
# These run against throwaway git repos. No VPS.

setup() {
  REPO="$BATS_TEST_TMPDIR/checkout"
  ORIGIN="$BATS_TEST_TMPDIR/origin.git"
  git init -q --bare "$ORIGIN"
  git init -q "$REPO"
  cd "$REPO"
  git config user.email t@t; git config user.name t
  mkdir -p docs platform/edge/dynamic platform/observability/prometheus
  echo "doc" > docs/readme.md
  echo "middlewares: {}" > platform/edge/dynamic/middlewares.yml
  echo "scrape: {}" > platform/observability/prometheus/prometheus.yml
  git add -A && git commit -qm init
  git remote add origin "$ORIGIN" && git push -q origin HEAD:main
  git fetch -q origin
  PF="$BATS_TEST_DIRNAME/../../scripts/preflight-checkout.sh"
}

@test "preflight passes on a clean tree" {
  run bash "$PF"
  [ "$status" -eq 0 ]
}

@test "preflight REFUSES when the tree is dirty" {
  echo "hand edit" >> docs/readme.md
  run bash "$PF"
  [ "$status" -ne 0 ]
}

@test "preflight PRINTS THE FULL DIFF — the only record of the hand-edit" {
  echo "MAGIC_HAND_EDIT_MARKER" >> docs/readme.md
  run bash "$PF"
  [[ "$output" == *"MAGIC_HAND_EDIT_MARKER"* ]]
}

@test "a dirty WATCHED path is called out as live production config" {
  echo "hand edit" >> platform/edge/dynamic/middlewares.yml
  run bash "$PF"
  [ "$status" -ne 0 ]
  [[ "$output" == *"LIVE"* ]]
  [[ "$output" == *"watch"* || "$output" == *"WATCHED"* ]]
}

@test "a dirty bind-mounted path is distinguished from an ordinary one" {
  echo "hand edit" >> platform/observability/prometheus/prometheus.yml
  run bash "$PF"
  [ "$status" -ne 0 ]
  [[ "$output" == *"BIND-MOUNTED"* ]]
}

@test "a dirty docs-only path is NOT labelled live" {
  echo "hand edit" >> docs/readme.md
  run bash "$PF"
  [[ "$output" != *"LIVE"* ]]
}

@test "ALLOW_DIRTY_CHECKOUT=1 overrides the refusal but still prints the diff" {
  echo "OVERRIDE_MARKER" >> docs/readme.md
  run env ALLOW_DIRTY_CHECKOUT=1 bash "$PF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OVERRIDE_MARKER"* ]]
}

@test "preflight reports how far the checkout is behind origin/main" {
  echo "upstream change" >> docs/readme.md
  git add -A && git commit -qm upstream && git push -q origin HEAD:main
  git reset -q --hard HEAD~1
  git fetch -q origin
  run bash "$PF"
  [[ "$output" == *"behind"* ]]
  [[ "$output" == *"1"* ]]
}

@test "drift is reported loudly when the checkout is stale" {
  for i in 1 2 3; do echo "c$i" >> docs/readme.md; git add -A; git commit -qm "c$i"; done
  git push -q origin HEAD:main
  git reset -q --hard HEAD~3
  git fetch -q origin
  run bash "$PF"
  [[ "$output" == *"3 commits behind"* ]]
}

@test "every deploy path calls the preflight before git reset --hard" {
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in .github/workflows/deploy-infra.yml \
            .github/workflows/reusable-deploy-service.yml \
            .github/workflows/vault-init.yml \
            .github/workflows/vault-reinitialize.yml; do
    grep -q "preflight-checkout.sh" "$wf" || { echo "missing preflight in $wf"; return 1; }
  done
}

@test "drift wording is correct when only AHEAD of origin/main" {
  echo "local only" >> docs/readme.md
  git add -A && git commit -qm "local-only commit"
  run bash "$PF"
  # Must not claim to be behind when it is not.
  [[ "$output" != *"0 commits behind"* ]]
  [[ "$output" == *"AHEAD"* ]]
  [[ "$output" == *"discard them"* ]]
}

@test "drift wording is correct when only BEHIND origin/main" {
  echo "upstream" >> docs/readme.md
  git add -A && git commit -qm up && git push -q origin HEAD:main
  git reset -q --hard HEAD~1 && git fetch -q origin
  run bash "$PF"
  [[ "$output" == *"1 commits behind"* ]]
  [[ "$output" != *"AHEAD"* ]]
}

# ---------------------------------------------------------------------------
# The guard must fail LEGIBLY when it is not on the box yet.
#
# The preflight ships in this repository, so it exists on /opt/hill90/app only
# AFTER one deploy that includes it. Until then every deploy path that calls it
# dies at `bash: scripts/preflight-checkout.sh: No such file or directory`,
# exit 127, with nothing saying what to do. Verified on 2026-07-29: the script is
# absent from the box and the checkout is at #563, four commits behind main, so
# this is the live state and not a hypothetical.
#
# Halting is correct — it is the fail-closed direction. Halting without an
# explanation is not. hill90-app solved this first; these tests port it back.
#
# The message must be BYTE-IDENTICAL in all four workflows so it is greppable.
# The four sites cannot share an abstraction (see the comment in the
# implementation), so a test is what keeps them in step.
# ---------------------------------------------------------------------------

DEPLOY_WORKFLOWS=(
  ".github/workflows/reusable-deploy-service.yml"
  ".github/workflows/deploy-infra.yml"
  ".github/workflows/vault-init.yml"
  ".github/workflows/vault-reinitialize.yml"
)

# The canonical text lives here, once. The implementation must match it exactly.
# It deliberately contains NO quote characters of either kind: two of the four
# call sites wrap the remote command in double quotes and two in single quotes,
# so any quote in the message would have to differ per site and stop being
# greppable.
EXPECTED_MESSAGE='::error::scripts/preflight-checkout.sh is missing from /opt/hill90/app on the VPS. It ships in this repository, so it exists on the box only AFTER one deploy that includes it. Fix: ssh to the VPS as deploy, run cd /opt/hill90/app && git pull, then re-run this workflow. Do not remove the guard to get past this.'

@test "every deploy path checks the preflight exists before running it" {
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in "${DEPLOY_WORKFLOWS[@]}"; do
    grep -q -- "-f scripts/preflight-checkout.sh" "$wf" \
      || { echo "no existence check in $wf — a missing script will exit 127 with no explanation"; return 1; }
  done
}

@test "the missing-preflight message is byte-identical in all four workflows" {
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in "${DEPLOY_WORKFLOWS[@]}"; do
    grep -qF -- "$EXPECTED_MESSAGE" "$wf" \
      || { echo "message missing or altered in $wf"; return 1; }
  done
}

@test "the message contains no quote characters — it must survive both quotings" {
  # Two sites embed the remote command in "..." and two in '...'. A quote in the
  # message would need escaping that differs per site, which is how four copies
  # stop being greppable.
  [[ "$EXPECTED_MESSAGE" != *"'"* ]]
  [[ "$EXPECTED_MESSAGE" != *'"'* ]]
}

@test "the message names the exact command that fixes it" {
  # The reader is someone whose deploy just failed. A diagnosis without a command
  # is a fifteen-minute detour.
  [[ "$EXPECTED_MESSAGE" == *"git pull"* ]]
  [[ "$EXPECTED_MESSAGE" == *"/opt/hill90/app"* ]]
}

@test "the existence check runs BEFORE the script is invoked, in each workflow" {
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in "${DEPLOY_WORKFLOWS[@]}"; do
    check_line=$(grep -n -- "-f scripts/preflight-checkout.sh" "$wf" | head -1 | cut -d: -f1)
    run_line=$(grep -n -- "bash scripts/preflight-checkout.sh" "$wf" | head -1 | cut -d: -f1)
    [ -n "$check_line" ] || { echo "no existence check in $wf"; return 1; }
    [ -n "$run_line" ]   || { echo "no invocation in $wf"; return 1; }
    # Same line is fine (a one-liner chains both); after is not.
    [ "$check_line" -le "$run_line" ] \
      || { echo "$wf checks for the script AFTER trying to run it"; return 1; }
  done
}

@test "the guard is still fail-closed — it exits rather than skipping the preflight" {
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in "${DEPLOY_WORKFLOWS[@]}"; do
    # The whole point is halting. A check that warns and continues would deploy
    # with no preflight at all, which is worse than the 127 it replaces.
    line=$(grep -- "-f scripts/preflight-checkout.sh" "$wf" | head -1)
    [[ "$line" == *"exit 1"* ]] \
      || { echo "$wf checks for the script but does not exit when it is absent"; return 1; }
  done
}
