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
# THE BOOTSTRAP DEADLOCK (app#139, ported here as app#140's issue #705).
#
# Every one of these five workflows used to run `bash scripts/preflight-
# checkout.sh` against the VPS's OWN checkout, in the same `&&` chain as the
# `git reset --hard origin/main` that is the only thing that updates it. So a
# defect in the guard could not be fixed by merging the fix — the old code
# decided whether the new code was allowed to run, and the deploy that would
# have delivered the fix was the deploy the unfixed guard was blocking.
#
# The fix: run the RUNNER's copy of the script, piped over ssh with
# `bash -s < scripts/preflight-checkout.sh`, as its own step, strictly BEFORE
# the step that runs `git reset --hard`. That also retires the old
# "preflight-checkout.sh is missing from the box" guard entirely — that
# failure mode existed only because the host's own copy was being invoked, and
# a script piped over stdin cannot be "missing".
# ---------------------------------------------------------------------------

DEPLOY_WORKFLOWS=(
  ".github/workflows/reusable-deploy-service.yml"
  ".github/workflows/deploy-infra.yml"
  ".github/workflows/vault-init.yml"
  ".github/workflows/vault-reinitialize.yml"
  ".github/workflows/vault-regain-root.yml"
)

@test "every deploy path pipes the RUNNER's preflight copy over ssh, not the host's" {
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in "${DEPLOY_WORKFLOWS[@]}"; do
    grep -q -- '< scripts/preflight-checkout.sh' "$wf" \
      || { echo "$wf does not pipe scripts/preflight-checkout.sh from the runner"; return 1; }
  done
}

@test "every deploy path calls the preflight step BEFORE the step that resets the host" {
  # THIS COMPARES STEP NAMES, not raw occurrences of "git reset --hard" — a
  # comment mentioning the old defect (see reusable-deploy-service.yml) also
  # contains that text, so a naive line-number grep across the whole file can
  # find a comment above the guard and call the ordering satisfied when it
  # is not. A step name is the thing that actually orders execution.
  cd "$BATS_TEST_DIRNAME/../.."
  for wf in "${DEPLOY_WORKFLOWS[@]}"; do
    pf_line=$(grep -n '^      - name: Checkout preflight' "$wf" | head -1 | cut -d: -f1)
    [ -n "$pf_line" ] || { echo "no preflight step in $wf"; return 1; }

    # The first `git reset --hard` at or after the preflight step's line is the
    # real invocation; anything earlier in the file is prose about the old bug.
    reset_line=$(tail -n "+$pf_line" "$wf" | grep -n 'git reset --hard' | head -1 | cut -d: -f1)
    [ -n "$reset_line" ] || { echo "no git reset --hard found after the preflight step in $wf"; return 1; }
    reset_line=$((pf_line + reset_line - 1))

    [ "$pf_line" -lt "$reset_line" ] \
      || { echo "$wf resets before (or without) running the preflight"; return 1; }
  done
}

@test "CONTROL: the ordering test can fail — it is not vacuously true" {
  # Proves the test above actually reads the file rather than passing on any
  # input: a workflow with the preflight step AFTER the reset must fail it.
  cd "$BATS_TEST_DIRNAME/../.."
  tmp="$BATS_TEST_TMPDIR/reordered.yml"
  cat > "$tmp" <<'EOF'
jobs:
  deploy:
    steps:
      - name: Deploy service
        run: |
          ssh host "cd /opt/hill90/app && git reset --hard origin/main"
      - name: Checkout preflight (this repo's copy, not the host's)
        run: |
          ssh host "cd /opt/hill90/app && bash -s" < scripts/preflight-checkout.sh
EOF
  pf_line=$(grep -n '^      - name: Checkout preflight' "$tmp" | head -1 | cut -d: -f1)
  reset_line=$(tail -n "+$pf_line" "$tmp" | grep -n 'git reset --hard' | head -1 | cut -d: -f1)
  # No reset found AT OR AFTER the (now-last) preflight step confirms the
  # fixture is genuinely reordered, not an accident of the grep.
  [ -z "$reset_line" ]
}
