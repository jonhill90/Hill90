#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_vault_revoke_order.py.
#
# #644 asked for the check to be "positive-controlled by reordering the steps and
# confirming it goes red". A check nobody has watched fail is not a check — and
# this estate has already shipped two of those: a green `amtool check-config` on a
# config that could not deliver, and a `promtool`-clean alert rule that could never
# fire. Both looked like evidence.
#
# So this does not merely assert the real repo passes. Each test MUTATES a copy and
# asserts the check goes red for that specific reason. If a future edit makes the
# check vacuous, these go green-when-they-should-be-red and CI notices.
#
# The mutations are deliberately of different KINDS: a pure reorder that adds and
# removes nothing, a deletion, a script-level guard removal, and a cross-job split.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/.github/workflows"
  cp "$ROOT/scripts/checks/check_vault_revoke_order.py" "$CTL/scripts/checks/"
  cp "$ROOT/scripts/vault.sh" "$CTL/scripts/"
  cp "$ROOT"/.github/workflows/*.yml "$CTL/.github/workflows/"
  CHECK="$CTL/scripts/checks/check_vault_revoke_order.py"
}

# Swap two whole step blocks in a workflow. Nothing is added or deleted, so a
# failure can only be about ORDER.
swap_steps() {
  local file="$1" a="$2" b="$3"
  python3 - "$file" "$a" "$b" <<'PY'
import re, sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(path).read()
parts = re.split(r"(?m)^(?=      - name:)", t)
head, steps = parts[0], parts[1:]
ia = next(i for i, s in enumerate(steps) if a in s)
ib = next(i for i, s in enumerate(steps) if b in s)
assert ia < ib, "precondition: first marker must currently precede the second"
steps[ia], steps[ib] = steps[ib], steps[ia]
open(path, "w").write(head + "".join(steps))
PY
}

@test "CONTROL: the check PASSES on the real, unmutated workflows" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "reordering setup-oidc AFTER revoke-root turns it red" {
  # A pure swap: same file, same invocations, different order.
  local wf="$CTL/.github/workflows/vault-init.yml"
  local before after
  before=$(grep -c "bash scripts/vault.sh" "$wf")
  swap_steps "$wf" "bash scripts/vault.sh setup-oidc" "bash scripts/vault.sh revoke-root"
  after=$(grep -c "bash scripts/vault.sh" "$wf")
  [ "$before" -eq "$after" ]          # nothing added or removed

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"revoke-root"* ]]
}

@test "deleting the setup-oidc step entirely turns it red" {
  local wf="$CTL/.github/workflows/vault-init.yml"
  python3 - "$wf" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
parts = re.split(r"(?m)^(?=      - name:)", t)
head, steps = parts[0], parts[1:]
steps = [s for s in steps if "bash scripts/vault.sh setup-oidc" not in s]
open(p, "w").write(head + "".join(steps))
PY
  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"revoke-root"* ]]
}

@test "a revoke in a SEPARATE job is not protected by OIDC in another job" {
  # Jobs are independent unless chained with `needs:`. The check carried
  # seen_oidc across the whole FILE until 2026-08-03 and passed this fixture.
  cat > "$CTL/.github/workflows/two-jobs.yml" <<'YML'
name: Two jobs
on: { workflow_dispatch: {} }
jobs:
  configure:
    runs-on: ubuntu-latest
    steps:
      - name: Enable OIDC
        run: |
          ssh deploy@host 'cd /opt/hill90/app && bash scripts/vault.sh setup-oidc'
  teardown:
    runs-on: ubuntu-latest
    steps:
      - name: Revoke root in a different job
        run: |
          ssh deploy@host 'cd /opt/hill90/app && bash scripts/vault.sh revoke-root'
YML
  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"teardown"* ]]
}

@test "removing assert_safe_to_revoke from bootstrap-approles turns it red" {
  # Workflow ordering cannot cover `vault.sh revoke-root` run by hand, nor
  # bootstrap-approles' own terminal revoke. The script-level guard is separate.
  python3 - "$CTL/scripts/vault.sh" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
m = re.search(r"^cmd_bootstrap_approles\(\)\s*\{(.*?)^\}", t, re.S | re.M)
body = m.group(0).replace("assert_safe_to_revoke", ": # removed for the control")
open(p, "w").write(t[:m.start()] + body + t[m.end():])
PY
  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"assert_safe_to_revoke"* ]]
}

@test "removing the assert_safe_to_revoke definition turns it red" {
  python3 - "$CTL/scripts/vault.sh" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read().replace("assert_safe_to_revoke()", "some_other_function()", 1)
open(p, "w").write(t)
PY
  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not defined"* ]]
}

@test "the check refuses to pass vacuously when it can see no workflows" {
  rm -f "$CTL"/.github/workflows/*.yml
  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"vacuously"* ]]
}

@test "bootstrap-approles before setup-oidc turns it red — it revokes on its way out" {
  # scripts/vault.sh cmd_bootstrap_approles ends with assert_safe_to_revoke and
  # `token revoke -self`. It is a revoke site, and running it before setup-oidc is
  # the exact sequence that closed the door during the #643 rebuild. No workflow
  # invokes it today, which is why this is encoded now rather than after one does.
  cat > "$CTL/.github/workflows/bootstrap-first.yml" <<'YML'
name: Bootstrap first
on: { workflow_dispatch: {} }
jobs:
  rebuild:
    runs-on: ubuntu-latest
    steps:
      - name: Bootstrap AppRoles
        run: |
          ssh deploy@host 'cd /opt/hill90/app && bash scripts/vault.sh bootstrap-approles'
      - name: Enable OIDC afterwards, which is too late
        run: |
          ssh deploy@host 'cd /opt/hill90/app && bash scripts/vault.sh setup-oidc'
YML
  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"bootstrap-approles"* ]]
}
