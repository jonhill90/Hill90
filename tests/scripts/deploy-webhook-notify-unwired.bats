#!/usr/bin/env bats
#
# h#816: DEPLOY_WEBHOOK_URL is unset on this repository, so both notification
# paths that depend on it were silently inert — `reusable-deploy-service.yml`
# skipped its step with no explanation, and `vault-sync-to-sops.yml`'s
# in-script guard ran, found the value empty, and exited quietly. The SAME
# file already warns loudly about a different missing secret
# (HILL90_APP_DISPATCH_TOKEN) three lines above the silent one — an asymmetry
# fixed here by copying that existing pattern onto DEPLOY_WEBHOOK_URL too,
# rather than inventing a new one.
#
# The cost of the silence is on record, not hypothetical: vault-sync-to-sops
# failed on 2026-08-03 and nobody knew until h#712's Prometheus rule shipped
# two days later (#789).
#
# A correction landed on the issue before this fix was written: `if:
# env.X != ''` DOES see that step's own `env:` block — proven from a real
# run (31043850839) where the sibling `Signal post-deploy hooks` step, using
# the identical pattern, actually executed. That pattern is correct and
# UNCHANGED by this fix; only the missing warning is added.
#
# No local GitHub Actions runner is available in this environment (no `act`),
# so these are the same structural/static checks this repo already uses for
# workflow YAML (see check_deploy_jobs_serialized.py and
# deploy-jobs-serialized-control.bats) — parse the YAML, and assert on the
# step shapes and text. The positive control is a real one even so: each
# assertion is shown to fail against the pre-fix file (see the commit history
# / PR description for the git-stash-based before/after run), not merely
# shown to pass against the file as fixed.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  DEPLOY_WF="$ROOT/.github/workflows/reusable-deploy-service.yml"
  SYNC_WF="$ROOT/.github/workflows/vault-sync-to-sops.yml"
}

@test "both workflow files still parse as valid YAML" {
  run python3 -c "import yaml; yaml.safe_load(open('$DEPLOY_WF'))"
  [ "$status" -eq 0 ]
  run python3 -c "import yaml; yaml.safe_load(open('$SYNC_WF'))"
  [ "$status" -eq 0 ]
}

@test "reusable-deploy-service.yml: the existing DISPATCH_TOKEN warn pattern is untouched" {
  # Anchor: this fix copies this step's shape. If this step ever moves or
  # changes shape, the copy below should be re-examined against it, not
  # assumed to still match.
  run grep -A2 'name: Warn that the post-deploy signal is unwired' "$DEPLOY_WF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"env.DISPATCH_TOKEN == ''"* ]]
}

@test "reusable-deploy-service.yml: Notify deploy result's own if: condition is unchanged" {
  # The suspected-but-refuted defect from the issue: env.X in a step's own
  # if: reading that step's own env: block. Refuted on real run evidence
  # (31043850839) — this test pins that the condition text was NOT touched
  # by this fix, since changing it would be an unrequested, unverified
  # change to a pattern already proven to work.
  run grep -A1 'name: Notify deploy result' "$DEPLOY_WF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"if: always() && env.DEPLOY_WEBHOOK_URL != ''"* ]]
}

@test "reusable-deploy-service.yml: an unset DEPLOY_WEBHOOK_URL now gets its own ::warning:: sibling step" {
  run grep -A5 'name: Warn that deploy result notification is unwired' "$DEPLOY_WF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"if: always() && env.DEPLOY_WEBHOOK_URL == ''"* ]]
  [[ "$output" == *'::warning::DEPLOY_WEBHOOK_URL is not set'* ]]
  [[ "$output" == *"Hill90#816"* ]]
}

@test "reusable-deploy-service.yml: the warn step's condition is the exact logical negation of the notify step's — no gap, no overlap" {
  notify_if="$(grep -A1 'name: Notify deploy result' "$DEPLOY_WF" | grep 'if:')"
  warn_if="$(grep -A1 'name: Warn that deploy result notification is unwired' "$DEPLOY_WF" | grep 'if:')"
  [[ "$notify_if" == *"env.DEPLOY_WEBHOOK_URL != ''"* ]]
  [[ "$warn_if" == *"env.DEPLOY_WEBHOOK_URL == ''"* ]]
  # Same always() gate on both, so together they are exhaustive: for any run,
  # exactly one of the two fires.
  [[ "$notify_if" == *"always()"* ]]
  [[ "$warn_if" == *"always()"* ]]
}

@test "vault-sync-to-sops.yml: Notify sync result's if: failure() gate is unchanged" {
  run grep -A1 'name: Notify sync result' "$SYNC_WF"
  [ "$status" -eq 0 ]
  [[ "$output" == *"if: failure()"* ]]
}

@test "vault-sync-to-sops.yml: the in-script guard now has an else that warns, instead of exiting silently" {
  # Extract the whole step body (from its name: line to the next top-level
  # "- name:" at the same indentation) so the assertion is anchored to THIS
  # step and cannot accidentally match the heartbeat step below it.
  body="$(sed -n '/name: Notify sync result/,/name: Emit scheduled-workflow heartbeat/p' "$SYNC_WF")"
  [[ "$body" == *"if [ -n \"\$DEPLOY_WEBHOOK_URL\" ]; then"* ]]
  [[ "$body" == *"else"* ]]
  [[ "$body" == *'::warning::DEPLOY_WEBHOOK_URL is not set'* ]]
  [[ "$body" == *"Hill90#816"* ]]
  # The success-path curl call is still there, unremoved.
  [[ "$body" == *"curl -sf -X POST"* ]]
}

@test "both warnings name DEPLOY_WEBHOOK_URL specifically, not a generic message that could apply to either secret" {
  run grep -c 'DEPLOY_WEBHOOK_URL is not set' "$DEPLOY_WF"
  [ "$status" -eq 0 ]
  [ "$output" -eq 1 ]
  run grep -c 'DEPLOY_WEBHOOK_URL is not set' "$SYNC_WF"
  [ "$status" -eq 0 ]
  [ "$output" -eq 1 ]
}
