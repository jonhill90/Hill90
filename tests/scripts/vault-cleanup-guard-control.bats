#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_vault_cleanup_guard.py.
#
# Same discipline as vault-revoke-order-control.bats: this does not merely
# assert the real repo passes. Each test MUTATES a copy and asserts the check
# goes red for that specific reason, so a future edit that makes the check
# vacuous is caught here rather than discovered the next time a copy-back
# fails mid-run.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  # Same directory depth as the real repo — the check resolves its own ROOT
  # as two parents up from scripts/checks/check_vault_cleanup_guard.py.
  mkdir -p "$CTL/scripts/checks" "$CTL/.github/workflows"
  cp "$ROOT/scripts/checks/check_vault_cleanup_guard.py" "$CTL/scripts/checks/"
  cp "$ROOT"/.github/workflows/vault-init.yml "$CTL/.github/workflows/"
  cp "$ROOT"/.github/workflows/vault-reinitialize.yml "$CTL/.github/workflows/"
  cp "$ROOT"/.github/workflows/vault-sync-to-sops.yml "$CTL/.github/workflows/"
  CHECK="$CTL/scripts/checks/check_vault_cleanup_guard.py"
}

run_check() {
  python3 "$CHECK"
}

@test "CONTROL: the check PASSES on the real, unmutated workflows" {
  run run_check
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "removing the copy-back step's id turns it red" {
  local wf="$CTL/.github/workflows/vault-init.yml"
  python3 - "$wf" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
lines = t.splitlines(keepends=True)
out = [l for l in lines if l.strip() != "id: copy-back"]
open(p, "w").write("".join(out))
PY
  ! grep -q "id: copy-back" "$wf"

  run run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"vault-init.yml"* ]]
  [[ "$output" == *"no \`id:\`"* ]]
}

@test "reverting the revert step's if: to a bare always() turns it red" {
  local wf="$CTL/.github/workflows/vault-reinitialize.yml"
  python3 - "$wf" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t = t.replace(
    "if: always() && steps.copy-back.outcome == 'success'",
    "if: always()",
    1,
)
open(p, "w").write(t)
PY
  run run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"vault-reinitialize.yml"* ]]
  [[ "$output" == *"does not reference"* ]]
}

# THE ASSERTION THAT MATTERS, per the reviewer's own finding: `!= 'failure'`
# was the check's own accepted pattern until this fix, and it is unsound —
# copy-back has no `if:` of its own in vault-init.yml/vault-reinitialize.yml,
# so it is SKIPPED (not failed) whenever an earlier step in the job already
# failed, and `!= 'failure'` is true for a skipped outcome too. Reachable for
# real: cmd_store_unseal_key writes the key into the host's checkout BEFORE
# its own round-trip verification runs, so a failure in that verification —
# its own anticipated case — left copy-back skipped, and the old pattern let
# the revert through in exactly that window.
@test "THE ASSERTION THAT MATTERS: a revert gated on != 'failure' (admits a SKIPPED copy-back) turns it red" {
  local wf="$CTL/.github/workflows/vault-init.yml"
  python3 - "$wf" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace(
    "if: always() && steps.copy-back.outcome == 'success'",
    "if: always() && steps.copy-back.outcome != 'failure'",
    1,
)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY
  run run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"vault-init.yml"* ]]
  [[ "$output" == *"does not reference"* ]]
}

@test "removing the revert step's if: condition entirely turns it red" {
  local wf="$CTL/.github/workflows/vault-sync-to-sops.yml"
  python3 - "$wf" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace(
    "        if: always() && (steps.compare.outputs.changed != 'true' || steps.copy-back.outcome == 'success')\n        run: |\n          ssh -i ~/.ssh/vps_key -o StrictHostKeyChecking=no -o ConnectTimeout=15 \\\n            deploy@${{ steps.get-ip.outputs.tailscale_ip }} \\\n            \"cd /opt/hill90/app && \\\n             git checkout -- infra/secrets/prod.enc.env",
    "        run: |\n          ssh -i ~/.ssh/vps_key -o StrictHostKeyChecking=no -o ConnectTimeout=15 \\\n            deploy@${{ steps.get-ip.outputs.tailscale_ip }} \\\n            \"cd /opt/hill90/app && \\\n             git checkout -- infra/secrets/prod.enc.env",
    1,
)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY
  run run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"vault-sync-to-sops.yml"* ]]
  [[ "$output" == *"no \`if:\` condition at all"* ]]
}

@test "a revert step with no preceding copy-back step at all turns it red" {
  cat > "$CTL/.github/workflows/synthetic.yml" <<'YML'
name: Synthetic
on: { workflow_dispatch: {} }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Restore host checkout
        if: always()
        run: |
          ssh deploy@host 'cd /opt/hill90/app && git checkout -- infra/secrets/prod.enc.env'
YML
  run run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"synthetic.yml"* ]]
  [[ "$output" == *"no preceding copy-back"* ]]
}

@test "the check refuses to pass vacuously when it can see no workflows" {
  rm -f "$CTL"/.github/workflows/*.yml
  run run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"vacuously"* ]]
}

# THE ASSERTION THAT MATTERS: REVERT_INVOCATION's regex going blind (a
# renamed or reshaped `git checkout` line) must report CANNOT DETERMINE
# rather than PASS having examined zero revert steps. Distinct from the test
# above — that one removes the FILES; this one keeps all three real files in
# place and only renames the invocation the regex hunts for, so `check_
# workflow()`'s per-file loop runs normally and finds nothing to flag.
@test "THE ASSERTION THAT MATTERS: every revert step losing its recognisable shape reports CANNOT DETERMINE, not PASS" {
  for wf in vault-init.yml vault-reinitialize.yml vault-sync-to-sops.yml; do
    sed -i.bak \
      -e 's/git checkout -- infra\/secrets\/prod\.enc\.env/git restore -- infra\/secrets\/prod.enc.env/' \
      "$CTL/.github/workflows/$wf"
    rm -f "$CTL/.github/workflows/$wf.bak"
  done
  # Sanity: the mutation actually applied, and no file still has the
  # original invocation the regex hunts for.
  ! grep -rq "git checkout -- infra/secrets/prod.enc.env" "$CTL/.github/workflows/"

  run run_check
  [ "$status" -eq 2 ]
  [[ "$output" == *"CANNOT DETERMINE"* ]]
  [[ "$output" == *"zero"* ]]
  # Not a bare substring check for "PASS" — the CANNOT DETERMINE message
  # itself legitimately says "Not reporting PASS for a run that examined
  # nothing", which trivially contains that substring. Check for the actual
  # success line instead.
  [[ "$output" != *"PASS — every host-checkout revert is gated"* ]]
}
