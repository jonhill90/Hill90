#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_retired_roles_ungranted.py.
#
# The hazard is inverted from the usual one: a grant attached to a role with ZERO
# holders is free today and expensive the moment someone is given the role. MinIO's
# `admin` policy was exactly that — s3:* plus admin:* arriving with a realm role
# nobody would have connected to object storage.
#
# Each test re-creates one such grant on a copy and requires red.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/deploy/compose/prod"
  cp "$ROOT/scripts/checks/check_retired_roles_ungranted.py" "$CTL/scripts/checks/"
  cp "$ROOT/scripts/keycloak.sh" "$ROOT/scripts/minio.sh" "$ROOT/scripts/vault.sh" "$CTL/scripts/"
  cp "$ROOT/deploy/compose/prod/docker-compose.observability.yml" "$CTL/deploy/compose/prod/"
  CHECK="$CTL/scripts/checks/check_retired_roles_ungranted.py"
}

@test "CONTROL: passes on the real, unmutated tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "CONTROL: the retired set is read from keycloak.sh and is not empty" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"admin, editor, user, viewer"* ]]
}

# Vacuity: if the retired list stops being readable the check has nothing to
# compare against. It must FAIL, not pass.
@test "an empty retired list fails rather than passing vacuously" {
  sed -i.bak 's/^REALM_ROLES_REMOVED=.*/REALM_ROLES_REMOVED=""/' "$CTL/scripts/keycloak.sh"
  rm -f "$CTL/scripts/keycloak.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"vacuously"* ]]
}

@test "re-creating the MinIO admin policy — the real over-grant — turns it red" {
  sed -i.bak 's/for policy in platform-admin platform-viewer; do/for policy in platform-admin platform-viewer admin editor viewer; do/' \
    "$CTL/scripts/minio.sh"
  rm -f "$CTL/scripts/minio.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"minio.sh still creates a policy named admin"* ]]
  [[ "$output" == *"union"* ]]
}

@test "pointing Grafana back at a retired role turns it red" {
  sed -i.bak "s/'platform-editor'/'editor'/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Grafana's role_attribute_path grants an org role to editor"* ]]
}

@test "pointing OpenBao's bound claim back at a retired role turns it red" {
  sed -i.bak 's/"realm_roles": \["platform-admin"\]/"realm_roles": ["admin"]/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"OpenBao's admin-sso role grants a vault policy to admin"* ]]
}

@test "listing a retired role in REALM_ROLES as well turns it red" {
  sed -i.bak 's/^REALM_ROLES="platform-admin/REALM_ROLES="admin platform-admin/' "$CTL/scripts/keycloak.sh"
  rm -f "$CTL/scripts/keycloak.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"created and deleted every run"* ]]
}
