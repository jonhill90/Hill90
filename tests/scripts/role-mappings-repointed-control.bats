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
