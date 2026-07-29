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
