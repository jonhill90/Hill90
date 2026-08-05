#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_root_revoke_fails_closed.py.
#
# #662 asked for the property to be PROVEN rather than read off the YAML: a run
# that fails at any step after the root token is minted must still revoke it.
# Reading the file for `always()` would re-encode the very assumption that was
# wrong — the author of the original condition also read it and believed it ran.
#
# So each test MUTATES a copy and requires the check to go red for that specific
# reason. If a future edit makes the check vacuous, these go green-when-red and
# CI notices. Modelled on tests/scripts/vault-revoke-order-control.bats from #659,
# which established the pattern for this estate.
#
# The mutations are of different KINDS on purpose: reverting a condition to the
# exact broken form from run 30791332461, deleting a cleanup step outright,
# removing a declared exemption, and adding prose that must NOT be mistaken for
# an action.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/.github/workflows"
  cp "$ROOT/scripts/checks/check_root_revoke_fails_closed.py" "$CTL/scripts/checks/"
  cp "$ROOT"/.github/workflows/*.yml "$CTL/.github/workflows/"
  CHECK="$CTL/scripts/checks/check_root_revoke_fails_closed.py"
}

# Replace a step's `if:` condition, identified by the step name above it.
set_condition() {
  local file="$1" step="$2" cond="$3"
  python3 - "$file" "$step" "$cond" <<'PY'
import re, sys
path, step, cond = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(path).read()
parts = re.split(r"(?m)^(?=      - name:)", t)
head, steps = parts[0], parts[1:]
i = next(i for i, s in enumerate(steps) if step in s.splitlines()[0])
assert re.search(r"(?m)^        if: .*$", steps[i]), f"step {step!r} has no if: to replace"
steps[i] = re.sub(r"(?m)^        if: .*$", f"        if: {cond}", steps[i], count=1)
open(path, "w").write(head + "".join(steps))
PY
}

delete_step() {
  local file="$1" step="$2"
  python3 - "$file" "$step" <<'PY'
import re, sys
path, step = sys.argv[1], sys.argv[2]
t = open(path).read()
parts = re.split(r"(?m)^(?=      - name:)", t)
head, steps = parts[0], parts[1:]
i = next(i for i, s in enumerate(steps) if step in s.splitlines()[0])
del steps[i]
open(path, "w").write(head + "".join(steps))
PY
}

@test "CONTROL: the check PASSES on the real, unmutated workflows" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

# NOT VACUOUS: if the mint is no longer recognised, every audit below silently
# skips and the whole file passes for the wrong reason. Pin the discovery.
@test "CONTROL: all three root-minting workflows are actually discovered" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"vault-init.yml"* ]]
  [[ "$output" == *"vault-regain-root.yml"* ]]
  [[ "$output" == *"vault-reinitialize.yml"* ]]
}

@test "reverting the revoke to the exact broken condition from run 30791332461 turns it red" {
  # This is verbatim what production shipped, and what left a live root token.
  set_condition "$CTL/.github/workflows/vault-regain-root.yml" \
    "Revoke the recovered root token" '${{ inputs.revoke_root_at_end }}'

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"Revoke the recovered root token"* ]]
  [[ "$output" == *"SKIPPED"* ]]
  [[ "$output" == *"live root token"* ]]
}

@test "the same break in vault-init.yml turns it red" {
  set_condition "$CTL/.github/workflows/vault-init.yml" \
    "Revoke root token" '${{ inputs.revoke_root }}'

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"vault-init.yml"* ]]
  [[ "$output" == *"Revoke root token"* ]]
}

@test "a revoke that runs but is never verified turns it red" {
  delete_step "$CTL/.github/workflows/vault-regain-root.yml" "ASSERT the root token is dead"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"never confirms the token is dead"* ]]
}

@test "a verification that is skipped on failure turns it red" {
  set_condition "$CTL/.github/workflows/vault-init.yml" \
    "Confirm root token is gone" '${{ inputs.revoke_root }}'

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Confirm root token is gone"* ]]
  [[ "$output" == *"skipped on failure"* ]]
}

@test "deleting the revoke step entirely turns it red" {
  delete_step "$CTL/.github/workflows/vault-regain-root.yml" "Revoke the recovered root token"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"never revokes it"* ]]
}

@test "removing the declared exemption from vault-reinitialize turns it red" {
  # The opt-out is what separates "decided" from "forgot". Without it, a
  # workflow that mints and never revokes must not pass quietly.
  local wf="$CTL/.github/workflows/vault-reinitialize.yml"
  grep -q "ROOT-TOKEN-DISPOSAL: deliberate" "$wf"
  sed -i.bak 's/ROOT-TOKEN-DISPOSAL: deliberate/(declaration removed)/' "$wf" && rm -f "$wf.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"never revokes it"* ]]
  [[ "$output" == *"ROOT-TOKEN-DISPOSAL: deliberate"* ]]
}

# PROSE IS NOT AN ACTION. The first red run of this check reported
# vault-reinitialize.yml as revoking a token, because its closing summary echoes
# the revoke command as an instruction to a human. A mention must never satisfy
# the requirement.
@test "an echoed revoke command does not count as revoking" {
  local wf="$CTL/.github/workflows/vault-reinitialize.yml"
  sed -i.bak 's/ROOT-TOKEN-DISPOSAL: deliberate/(declaration removed)/' "$wf" && rm -f "$wf.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  # It already echoes `bash scripts/vault.sh revoke-root` in its summary step.
  # If prose counted, this would report a skipped revoke instead of an absent one.
  [[ "$output" == *"never revokes it"* ]]
  [[ "$output" != *"is SKIPPED"* ]]
}

# The property itself, stated as a test rather than inferred: inject a NEW
# failing step at each position after the mint and require the check to still
# pass — that is what "fails closed at ANY step" means.
@test "a failure injected at any step after the mint still leaves the revoke reachable" {
  python3 - "$CTL/.github/workflows/vault-regain-root.yml" <<'PY'
import re, sys
path = sys.argv[1]
t = open(path).read()
parts = re.split(r"(?m)^(?=      - name:)", t)
head, steps = parts[0], parts[1:]
mint = next(i for i, s in enumerate(steps) if "vault.sh regain-root" in s)
revoke = next(i for i, s in enumerate(steps) if "vault.sh revoke-root" in s)
injected = "      - name: INJECTED FAILURE\n        run: exit 1\n\n"
# Insert at every position between the mint and the revoke, one file at a time
# is unnecessary — inserting them all at once is strictly harsher.
out = steps[: mint + 1]
for i in range(mint + 1, revoke + 1):
    out.append(injected)
    out.append(steps[i])
out += steps[revoke + 1 :]
open(path, "w").write(head + "".join(out))
PY

  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

# THE ASSERTION THAT MATTERS: MINT's invocation strings going blind (a renamed
# or reshaped vault.sh subcommand) must refuse rather than reporting PASS
# having audited zero workflows. vault-regain-root.yml and vault-init.yml are
# known, current root-minting workflows — a run that finds none is a check
# that stopped looking, not an estate that stopped minting root tokens. Same
# shape as check_vault_covers_compose.py's declared()/required_vars() guards.
@test "THE ASSERTION THAT MATTERS: no root-minting workflow found at all refuses rather than passing vacuously" {
  for f in "$CTL"/.github/workflows/*.yml; do
    sed -i.bak \
      -e 's/vault\.sh regain-root/vault.sh reclaim-root/g' \
      -e 's/vault\.sh init/vault.sh bootstrap-root/g' \
      "$f"
    rm -f "$f.bak"
  done

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"no root-minting workflow found at all"* ]]
  [[ "$output" != *"PASS"* ]]
}
