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

@test "CONTROL: the sweep actually looks — it reports the known findings" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"render-traefik-config.sh"* ]]
  [[ "$output" == *"preflight-edge.sh"* ]]
  [[ "$output" == *"known and tracked (baseline): 4"* ]]
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
@test "fixing a baseline finding without removing the entry FAILS as stale" {
  python3 - "$CTL/scripts/deploy.sh" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace('bash "$SCRIPT_DIR/render-traefik-config.sh"',
               'bash "$SCRIPT_DIR/render-traefik-config.sh" || exit 1')
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
