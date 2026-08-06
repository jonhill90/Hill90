#!/usr/bin/env bats
#
# h#776: sibling-pair sweep against check_retired_roles_ungranted.py found
# minio-policy-names-test.sh had never been positive-controlled at all — it
# was only ever exercised as a STUBBED remote command inside the Python
# check's own --live tests, which never runs this script's actual logic.
# That sweep is the reason two real defects surfaced here, both fixed
# alongside this file:
#
#   1. The legacy-role warn loop was hardcoded `admin editor viewer`,
#      silently missing `user` after keycloak.sh's REALM_ROLES_REMOVED grew
#      a fourth retired name. Now read from keycloak.sh directly, same
#      discipline check_retired_roles_ungranted.py already used.
#   2. Every "cannot determine" guard (MinIO unreachable, credentials
#      unavailable, policy list unreadable) exited 1 — the same code as a
#      genuine collision. A caller keying off exit code alone could not
#      tell an infra outage from a real security finding. Now exit 2,
#      matching check_retired_roles_ungranted.py's own 0/1/2 contract.
#
# `docker` and `sops` are stubbed; no real MinIO, Keycloak, or Docker daemon
# is involved.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"

  export MINIO_CONTAINER=fake-minio
  export KC_CONTAINER=fake-keycloak
  export MINIO_SECRETS_FILE="$BATS_TEST_TMPDIR/fake-secrets.enc.env"
  touch "$MINIO_SECRETS_FILE"

  CHECK="$ROOT/scripts/checks/minio-policy-names-test.sh"
}

stub_sops_credentials() {
  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
echo "MINIO_ROOT_USER=testuser"
echo "MINIO_ROOT_PASSWORD=testpass"
EOF
  chmod +x "$STUB/sops"
}

# $1 = "minio-up" | "minio-down"   $2 = "kc-up" | "kc-down"
# $3 = newline-separated policy list (only used when minio-up)
stub_docker() {
  local minio_state="$1" kc_state="$2" policies="$3"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "inspect" ]; then
  case "\$2" in
    fake-minio)
      [ "$minio_state" = "minio-up" ] && exit 0 || exit 1
      ;;
    fake-keycloak)
      [ "$kc_state" = "kc-up" ] && exit 0 || exit 1
      ;;
  esac
  exit 1
fi
if [ "\$1" = "exec" ]; then
  printf '%s\n' "$policies"
  exit 0
fi
exit 1
EOF
  chmod +x "$STUB/docker"
}

@test "CONTROL: a clean policy set (no collisions, no legacy names) passes" {
  stub_sops_credentials
  stub_docker minio-up kc-up "platform-admin
platform-viewer"
  run bash "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NO UNIVERSAL-ROLE COLLISIONS"* ]]
}

@test "THE CASE THAT MATTERS: a policy named after a universal automatic claim is a real collision, exit 1" {
  stub_sops_credentials
  stub_docker minio-up kc-up "platform-admin
offline_access"
  run bash "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"COLLISION: policy 'offline_access' is granted to every account"* ]]
}

@test "h#776 FIX 1: the legacy warn list now includes 'user', not just admin/editor/viewer" {
  stub_sops_credentials
  stub_docker minio-up kc-up "platform-admin
user"
  run bash "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"policy 'user' exists and is named after a realm role"* ]]
}

@test "h#776 FIX 1, mutation check: the legacy list is READ from keycloak.sh, not re-hardcoded" {
  run grep -n 'for legacy in admin editor viewer' "$CHECK"
  [ "$status" -ne 0 ]
  run grep -n 'REALM_ROLES_REMOVED' "$CHECK"
  [ "$status" -eq 0 ]
}

@test "the legacy warn is a warning, not a failure — exit stays 0 even when a legacy-named policy exists" {
  stub_sops_credentials
  stub_docker minio-up kc-up "platform-admin
admin
editor
viewer
user"
  run bash "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"policy 'admin' exists"* ]]
  [[ "$output" == *"policy 'editor' exists"* ]]
  [[ "$output" == *"policy 'viewer' exists"* ]]
  [[ "$output" == *"policy 'user' exists"* ]]
}

@test "h#776 FIX 2: MinIO unreachable is CANNOT DETERMINE (exit 2), not the same code as a real collision" {
  stub_sops_credentials
  stub_docker minio-down kc-up ""
  run bash "$CHECK"
  [ "$status" -eq 2 ]
  [[ "$output" == *"cannot determine"* ]]
}

@test "h#776 FIX 2: missing MinIO credentials is CANNOT DETERMINE (exit 2)" {
  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
echo "SOME_UNRELATED_KEY=x"
EOF
  chmod +x "$STUB/sops"
  stub_docker minio-up kc-up ""
  run bash "$CHECK"
  [ "$status" -eq 2 ]
  [[ "$output" == *"credentials unavailable — cannot determine"* ]]
}

@test "h#776 FIX 2: an empty policy list is CANNOT DETERMINE (exit 2), not a silent clean pass" {
  stub_sops_credentials
  stub_docker minio-up kc-up ""
  run bash "$CHECK"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Could not list MinIO policies — cannot determine"* ]]
}

@test "exit codes for clean / real-collision / cannot-determine are three genuinely different states" {
  stub_sops_credentials

  stub_docker minio-up kc-up "platform-admin"
  run bash "$CHECK"
  clean_status="$status"

  stub_docker minio-up kc-up "offline_access"
  run bash "$CHECK"
  collision_status="$status"

  stub_docker minio-down kc-up ""
  run bash "$CHECK"
  unreachable_status="$status"

  [ "$clean_status" -eq 0 ]
  [ "$collision_status" -eq 1 ]
  [ "$unreachable_status" -eq 2 ]
}

@test "Keycloak absent for the legacy check does not fail the run — it is a distinct, honest skip" {
  stub_sops_credentials
  stub_docker minio-up kc-down "platform-admin"
  run bash "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Keycloak container absent — not checked, which is not the same as clear"* ]]
}
