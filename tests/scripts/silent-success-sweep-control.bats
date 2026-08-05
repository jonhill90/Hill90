#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_silent_success.py.
#
# The sweep exists to find the SIXTH member of the family before it causes an
# outage. A sweep that cannot re-find the five already-closed members is not
# looking for anything, so the tests below regress the two machine-detectable
# ones and require it to report them as NEW.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/scripts" "$CTL/.github/workflows"
  cp "$ROOT/scripts/checks/check_silent_success.py" "$CTL/scripts/checks/"
  cp "$ROOT"/scripts/*.sh "$CTL/scripts/"
  cp "$ROOT"/.github/workflows/*.yml "$CTL/.github/workflows/"
  CHECK="$CTL/scripts/checks/check_silent_success.py"
}

@test "CONTROL: passes on the real tree — findings are the tracked baseline only" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no NEW instance beyond the tracked baseline"* ]]
}

@test "CONTROL: the baseline is EMPTY — every sweep finding has been fixed" {
  # All four are closed: deploy.sh:236/:243 with #676, the two workflow
  # conditions with this change. An empty baseline is the goal state, not a
  # broken check — tests 3 and 4 prove the sweep can still see.
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"known and tracked (baseline): 0"* ]]
  [[ "$output" == *"A. swallowed inside a fallback subshell: 0"* ]]
  [[ "$output" == *"B. cleanup/assertion skipped on failure: 0"* ]]
}

# REGRESSION OF #671 — the pre-up hook whose refusal was discarded.
@test "re-introducing the #671 swallowed pre-up hook is reported as NEW" {
  # Done in python, not sed: the pattern contains `||`, which sed reads as a flag.
  python3 - "$CTL/scripts/deploy.sh" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace('bash "$SCRIPT_DIR/$pre_up_hook" || exit 1', 'bash "$SCRIPT_DIR/$pre_up_hook"')
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"NEW:"* ]]
  [[ "$output" == *"pre_up_hook"* ]]
}

# REGRESSION OF #663 — the revoke skipped exactly when a run failed.
@test "re-introducing the #663 skip-on-failure revoke is reported as NEW" {
  python3 - "$CTL/.github/workflows/vault-regain-root.yml" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("if: ${{ always() && inputs.revoke_root_at_end }}",
               "if: ${{ inputs.revoke_root_at_end }}")
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"NEW:"* ]]
  [[ "$output" == *"Revoke the recovered root token"* ]]
}

# A BASELINE THAT ROTS IS SCAFFOLDING. Fixing a finding must force its removal.
@test "a baseline entry with nothing matching it FAILS as stale" {
  # The baseline is empty now, so plant one and confirm the staleness rule still
  # bites. Without this, emptying the baseline would silently retire the rule.
  python3 - "$CHECK" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("BASELINE: dict[str, str] = {}",
               'BASELINE = {"deploy.sh:999": "a finding that no longer exists"}')
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"STALE baseline entry"* ]]
}

@test "a deliberate case in the allowlist is not reported" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  # 'Refuse without the typed confirmation' is the first step of its job, so its
  # implicit success() is unreachable. It must not appear as a finding.
  [[ "$output" != *"Refuse without the typed confirmation' reads as cleanup"* ]]
}

# WIRING, not logic (h#736/h#758): every test above proves the check's LOGIC
# is correct. None of them prove anything ever RUNS it — before this fix, this
# check's only caller anywhere was this bats file, exactly the TEST-ONLY
# outcome h#736 taught check_checks_are_wired.py to catch. Fully hermetic (no
# live host — see the check's own docstring), so unlike h#738 there was no
# design question about WHERE it could run: ci.yml, on every PR. Note this is
# a separate question from the check being USED throughout h#758's own
# investigation as a regression detector for `if:` conditions on other new
# steps — using it as a tool never proved anything ran it in CI.
@test "h#758: ci.yml genuinely invokes this check, not just mentions it" {
  run grep -n "run: python3 scripts/checks/check_silent_success.py" \
    "$ROOT/.github/workflows/ci.yml"
  [ "$status" -eq 0 ]
}
