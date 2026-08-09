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

@test "an automatic realm-role MinIO policy turns the static check red before deploy" {
  sed -i.bak 's/for policy in platform-admin platform-viewer; do/for policy in platform-admin platform-viewer offline_access; do/' \
    "$CTL/scripts/minio.sh"
  rm -f "$CTL/scripts/minio.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"offline_access"* ]]
  [[ "$output" == *"every realm member"* ]]
}

@test "pointing Grafana back at a retired role turns it red" {
  sed -i.bak "s/'platform-editor'/'editor'/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Grafana's role_attribute_path grants an org role to editor"* ]]
}

@test "pointing Grafana at an automatic realm role turns it red" {
  sed -i.bak "s/'platform-editor'/'offline_access'/" \
    "$CTL/deploy/compose/prod/docker-compose.observability.yml"
  rm -f "$CTL/deploy/compose/prod/docker-compose.observability.yml.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Grafana's role_attribute_path grants an org role to automatic role offline_access"* ]]
}

@test "pointing OpenBao's bound claim back at a retired role turns it red" {
  sed -i.bak 's/"realm_roles": \["platform-admin"\]/"realm_roles": ["admin"]/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"OpenBao's admin-sso role grants a vault policy to admin"* ]]
}

@test "pointing OpenBao at an automatic realm role turns it red" {
  sed -i.bak 's/"realm_roles": \["platform-admin"\]/"realm_roles": ["uma_authorization"]/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"OpenBao's admin-sso role grants a vault policy to automatic role uma_authorization"* ]]
}

@test "listing a retired role in REALM_ROLES as well turns it red" {
  sed -i.bak 's/^REALM_ROLES="platform-admin/REALM_ROLES="admin platform-admin/' "$CTL/scripts/keycloak.sh"
  rm -f "$CTL/scripts/keycloak.sh.bak"

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"created and deleted every run"* ]]
}

# ---------------------------------------------------------------- --live ----
#
# h#727: `ssh(cmd) or "[]"` turned "the ssh call failed and stdout is empty"
# into valid JSON for an empty list, so the surrounding except never fired and
# an unreachable host printed a PASS having measured nothing. The danger is
# inverted from the usual check-writing instinct: the null result here
# AGREES with what everyone hopes ("no retired role is granted"), which is
# exactly the wrong direction for a security check to fail in.
#
# These stub the literal `ssh vps <cmd>` invocation the script makes — a real
# throwaway SSH server (linuxserver/openssh-server, alias temporarily
# resolved to it) was used to positive-control this fix directly against a
# genuine network round-trip during development; these bats tests are the
# permanent, fast, CI-safe regression form of that same verification, driven
# by a PATH-shadowing `ssh` stub rather than a live container.

setup_ssh_stub() {
  local scenario="$1"
  STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
  mkdir -p "$STUB_DIR"
  cat > "$STUB_DIR/ssh" <<STUB
#!/bin/bash
# argv: vps '<remote command string>'
cmd="\$2"
case "\$cmd" in
  *"kcadm.sh get roles"*)
    case "$scenario" in
      clean)          echo '[{"name":"platform-admin"},{"name":"platform-editor"},{"name":"platform-viewer"}]'; exit 0 ;;
      retired-found)  echo '[{"name":"platform-admin"},{"name":"admin"}]'; exit 0 ;;
      kc-cmd-fails)   echo "remote: keycloak container is restarting" >&2; exit 1 ;;
      kc-unreachable) echo "ssh: connect to host 100.88.29.112 port 22: Connection refused" >&2; exit 255 ;;
    esac
    ;;
  *"minio-policy-names-test.sh"*)
    case "$scenario" in
      clean|kc-cmd-fails|kc-unreachable) echo "  MinIO policies: platform-admin platform-viewer"; exit 0 ;;
      retired-found)                     echo "  MinIO policies: platform-admin admin"; exit 0 ;;
    esac
    ;;
esac
exit 0
STUB
  chmod +x "$STUB_DIR/ssh"
}

@test "--live CONTROL: a clean live estate passes" {
  setup_ssh_stub clean
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
  [[ "$output" == *"live realm roles: retired ones still present = none"* ]]
}

@test "--live: a retired role genuinely present on the live realm turns it red (exit 1, not 2)" {
  setup_ssh_stub retired-found
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  [ "$status" -eq 1 ]
  [[ "$output" == *"realm role admin is still present on the live realm"* ]]
  [[ "$output" == *"MinIO policy admin still exists"* ]]
}

@test "THE ASSERTION THAT MATTERS: a remote command failure refuses to answer (exit 2), never a silent PASS" {
  setup_ssh_stub kc-cmd-fails
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  [ "$status" -eq 2 ]
  [[ "$output" == *"CANNOT DETERMINE"* ]]
  [[ "$output" != *"PASS"* ]]
}

@test "THE ASSERTION THAT MATTERS: an unreachable host refuses to answer (exit 2), never a silent PASS" {
  setup_ssh_stub kc-unreachable
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  [ "$status" -eq 2 ]
  [[ "$output" == *"CANNOT DETERMINE"* ]]
  [[ "$output" == *"Connection refused"* ]]
  [[ "$output" != *"PASS"* ]]
}

@test "exit codes for clean / real-violation / cannot-determine are three genuinely different states" {
  setup_ssh_stub clean
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  clean_status="$status"

  setup_ssh_stub retired-found
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  found_status="$status"

  setup_ssh_stub kc-unreachable
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  unreachable_status="$status"

  [ "$clean_status" -eq 0 ]
  [ "$found_status" -eq 1 ]
  [ "$unreachable_status" -eq 2 ]
}

# --------------------------------------------------------------- --local ----
#
# h#738: --live had no caller anywhere. `ssh vps <cmd>` is a literal SSH
# CONFIG ALIAS that only resolves on a workstation whose personal
# ~/.ssh/config defines `Host vps` — no workflow in this repo ever
# establishes it, which is the actual reason --live was unwireable, not a
# missing workflow step. --local runs the same commands directly instead,
# matching the shape minio-policy-names-test.sh and check_alert_series.py
# already use once a workflow has SSH'd onto the VPS.
#
# THE ASSERTION THAT MATTERS, proven without any stub: this sandbox has no
# /opt/hill90/app, so the remote command's own `cd /opt/hill90/app` fails
# immediately if run as a literal local command. That failure message is
# categorically different from what an accidental `ssh vps <cmd>` call would
# produce (a hostname-resolution or connection failure, not a `cd` error) —
# so which message appears proves which transport actually ran, without
# needing to stub ssh, docker, or anything else.

@test "--live --local runs the command directly (bash -c), not via ssh vps" {
  run python3 "$CHECK" --live --local
  [ "$status" -eq 2 ]
  [[ "$output" == *"CANNOT DETERMINE"* ]]
  # Proves bash -c actually ran the command string locally: a `cd` failure,
  # not an ssh/hostname-resolution failure.
  [[ "$output" == *"No such file or directory"* ]]
  [[ "$output" != *"Could not resolve hostname"* ]]
}

@test "--local is a no-op without --live — static mode is unaffected" {
  run python3 "$CHECK" --local
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
  [[ "$output" != *"CANNOT DETERMINE"* ]]
}

@test "default --live (no --local) still goes through ssh vps, unchanged from h#727" {
  setup_ssh_stub clean
  run env PATH="$STUB_DIR:$PATH" python3 "$CHECK" --live
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}
