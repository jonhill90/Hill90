#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_role_mappings_repointed.py.
#
# The defect: Stage 2a repointed ONE arm of Grafana's role_attribute_path and
# left the other naming a zero-holder role, so the config read as finished. Each
# test mutates a copy and requires red for one specific reason — the pattern from
# #659, #663 and #664.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/deploy/compose/prod" "$CTL/scripts"
  cp "$ROOT/scripts/checks/check_role_mappings_repointed.py" "$CTL/scripts/checks/"
  cp "$ROOT/deploy/compose/prod/docker-compose.observability.yml" "$CTL/deploy/compose/prod/"
  cp "$ROOT/scripts/vault.sh" "$CTL/scripts/"
  CHECK="$CTL/scripts/checks/check_role_mappings_repointed.py"
}

@test "CONTROL: passes on the real, unmutated tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "CONTROL: both mapping sites are actually found" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Grafana role_attribute_path"* ]]
  [[ "$output" == *"OpenBao admin-sso bound_claims"* ]]
  [[ "$output" == *"2 mapping(s) checked"* ]]
}

@test "restoring the exact half-repointed expression that shipped turns it red" {
  sed -i.bak "s/'platform-editor'/'editor'/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"editor"* ]]
  [[ "$output" == *"zero holders"* ]]
}

@test "regressing the admin arm turns it red too" {
  sed -i.bak "s/'platform-admin'/'admin'/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Grafana role_attribute_path"* ]]
}

@test "regressing OpenBao's bound claim turns it red" {
  sed -i.bak 's/"realm_roles": \["platform-admin"\]/"realm_roles": ["admin"]/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"OpenBao admin-sso bound_claims"* ]]
}

# h#729: a NARROWER version of the same silent-pass class. The site's line IS
# found (line_re matches), but the inner role_re can't extract any role names
# from it — e.g. single quotes rewritten to double quotes. That used to
# `continue` silently: not a MISS, not caught by the "gone blind" guard above
# (which only fires when line_re matches nothing at all), invisible.
@test "THE ASSERTION THAT MATTERS: a site whose role names become unparseable turns it red, not silently dropped" {
  sed -i.bak "s/'platform-admin'/\"platform-admin\"/; s/'platform-editor'/\"platform-editor\"/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"no role names could be extracted"* ]]
  # Must not be silently indistinguishable from a genuine clean pass: the
  # OTHER site (OpenBao) is still fine, so the run must not read as PASS.
  [[ "$output" != *"PASS"* ]]
}

@test "CONTROL: an unparseable site does not block a genuinely legacy-named OTHER site from also being reported" {
  sed -i.bak "s/'platform-admin'/\"platform-admin\"/; s/'platform-editor'/\"platform-editor\"/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"
  sed -i.bak 's/"realm_roles": \["platform-admin"\]/"realm_roles": ["admin"]/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no role names could be extracted"* ]]
  [[ "$output" == *"OpenBao admin-sso bound_claims"* ]]
}

# A check that stops finding its target is a check that stopped checking, and it
# would go green. That is the same silent-pass class as the defect itself.
@test "a mapping site that disappears turns it red rather than green" {
  sed -i.bak '/GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH/d' \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"gone blind"* ]]
}

# WIRING, not logic (h#736/h#758): every test above proves the check's LOGIC
# is correct. None of them prove anything ever RUNS it — before this fix, this
# check's only caller anywhere was this bats file, exactly the TEST-ONLY
# outcome h#736 taught check_checks_are_wired.py to catch. Fully hermetic (no
# live Keycloak — see the check's own docstring), so unlike h#738 there was no
# design question about WHERE it could run: ci.yml, on every PR.
@test "h#758: ci.yml genuinely invokes this check, not just mentions it" {
  run grep -n "run: python3 scripts/checks/check_role_mappings_repointed.py" \
    "$ROOT/.github/workflows/ci.yml"
  [ "$status" -eq 0 ]
}
