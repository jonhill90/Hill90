#!/usr/bin/env bats
#
# h#749: keycloak.sh's cmd_apply/cmd_tenant_clients and local.sh's cmd_up all
# end with an unconditional success message, regardless of how many per-item
# warn() calls fired inside the loops they run — e.g. one of five per-user
# role grants failing partway through ensure_platform_admins was logged and
# then forgotten. cmd_health (local.sh) already has the right shape: a
# `failed` accumulator gates both the final message and the function's own
# return value. This applies that same shape to the four functions the issue
# names.
#
# `docker` is stubbed for the keycloak.sh functions — kc() wraps `docker exec
# "$KC_CONTAINER" kcadm.sh "$@"` (keycloak.sh:115) — so no real Keycloak is
# involved. cmd_apply/cmd_tenant_clients/cmd_up themselves do far more
# (require_running, kc_login, multiple secret_for calls, docker compose) than
# is practical to stub for a full run, so those three are checked statically:
# that the aggregation wiring (`fn || failed=1`, gated final message, gated
# return) is actually present, rather than retested from scratch — the
# underlying accumulator LOGIC is what the functional tests below prove.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
}

# ---------------------------------------------------------------------------
# remove_realm_roles — functional
# ---------------------------------------------------------------------------

make_kc_stub_remove_roles() {
  local mode="$1"  # "clean" | "holders" | "delete-fails" | "users-read-fails"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
MODE="$mode"
args=("\$@")
sub="\${args[3]}"; target="\${args[4]:-}"
case "\$sub \$target" in
  "get roles") echo "admin"; exit 0 ;;
  "get roles/admin/users")
    [ "\$MODE" = "users-read-fails" ] && exit 1
    [ "\$MODE" = "holders" ] && echo "u1"
    exit 0 ;;
  "get roles/admin/groups") exit 0 ;;
  "get roles/admin/composites") exit 0 ;;
  "delete roles/admin")
    [ "\$MODE" = "delete-fails" ] && exit 1
    exit 0 ;;
esac
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_remove_roles() {
  cd "$ROOT"
  source scripts/keycloak.sh help >/dev/null 2>&1
  REALM_ROLES_REMOVED=admin remove_realm_roles
}

@test "remove_realm_roles: clean run (real deletion) returns 0" {
  make_kc_stub_remove_roles "clean"
  run run_remove_roles
  [ "$status" -eq 0 ]
}

@test "remove_realm_roles: a role blocked by real holders returns non-zero" {
  make_kc_stub_remove_roles "holders"
  run run_remove_roles
  [ "$status" -ne 0 ]
}

@test "remove_realm_roles: a failed delete returns non-zero" {
  make_kc_stub_remove_roles "delete-fails"
  run run_remove_roles
  [ "$status" -ne 0 ]
}

@test "remove_realm_roles: a h#746-style failed READ also feeds this function's return status, not just its own warn" {
  # Rebased onto h#746 (#826), which added three read-failure warn+continue
  # branches to this same function without touching its return value. This
  # asserts they were actually wired into the failed accumulator this PR
  # adds, not merely left to coexist with it unconnected.
  make_kc_stub_remove_roles "users-read-fails"
  run run_remove_roles
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not read current USER holders"* ]]
}

# ---------------------------------------------------------------------------
# ensure_platform_admins — functional. "missing" and "grant failure" are
# deliberately different outcomes: a missing user on a fresh realm is a
# documented, expected no-op and must NOT fail the function; an actual grant
# failure must.
# ---------------------------------------------------------------------------

make_kc_stub_admins() {
  local mode="$1"  # "clean" | "missing-user" | "grant-fails"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
MODE="$mode"
args=("\$@")
sub="\${args[3]}"; target="\${args[4]:-}"
case "\$sub \$target" in
  "get users")
    [ "\$MODE" = "missing-user" ] && exit 0
    echo "user-uuid-1"
    exit 0 ;;
  "add-roles "*)
    [ "\$MODE" = "grant-fails" ] && exit 1
    exit 0 ;;
esac
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_admins() {
  cd "$ROOT"
  source scripts/keycloak.sh help >/dev/null 2>&1
  PLATFORM_ADMIN_USERS=jon ensure_platform_admins
}

@test "ensure_platform_admins: clean grants return 0" {
  make_kc_stub_admins "clean"
  run run_admins
  [ "$status" -eq 0 ]
}

@test "ensure_platform_admins: a MISSING user is informational only — still returns 0" {
  make_kc_stub_admins "missing-user"
  run run_admins
  [ "$status" -eq 0 ]
  [[ "$output" == *"does not exist"* ]]
}

@test "THE CASE THAT MATTERS: an actual grant FAILURE returns non-zero, distinct from the missing-user case" {
  make_kc_stub_admins "grant-fails"
  run run_admins
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not grant platform-admin"* ]]
}

# ---------------------------------------------------------------------------
# ensure_client_roles — functional
# ---------------------------------------------------------------------------

make_kc_stub_client_roles() {
  local mode="$1"  # "clean" | "create-fails"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
MODE="$mode"
args=("\$@")
sub="\${args[3]}"; target="\${args[4]:-}"
case "\$sub \$target" in
  "get clients/uuid-1/roles") exit 0 ;;
  "create clients/uuid-1/roles")
    [ "\$MODE" = "create-fails" ] && exit 1
    exit 0 ;;
esac
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_client_roles() {
  cd "$ROOT"
  source scripts/keycloak.sh help >/dev/null 2>&1
  ensure_client_roles uuid-1 user admin
}

@test "ensure_client_roles: clean creation returns 0" {
  make_kc_stub_client_roles "clean"
  run run_client_roles
  [ "$status" -eq 0 ]
}

@test "ensure_client_roles: a failed role creation returns non-zero" {
  make_kc_stub_client_roles "create-fails"
  run run_client_roles
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not create client role"* ]]
}

# ---------------------------------------------------------------------------
# STATIC: the aggregation wiring in cmd_apply / cmd_tenant_clients / cmd_up
# ---------------------------------------------------------------------------

@test "STATIC: cmd_apply aggregates remove_realm_roles and ensure_platform_admins, gates its final message and return" {
  run bash -c "sed -n '/^cmd_apply()/,/^cmd_status()/p' '$ROOT/scripts/keycloak.sh'"
  [[ "$output" == *"remove_realm_roles || apply_failed=1"* ]]
  [[ "$output" == *"ensure_platform_admins || apply_failed=1"* ]]
  [[ "$output" == *'if [ "$apply_failed" -eq 0 ]'* ]]
  [[ "$output" == *'[ "$apply_failed" -eq 0 ] || return 1'* ]]
}

@test "STATIC: cmd_tenant_clients aggregates ensure_client_roles, gates its final message and return" {
  run bash -c "sed -n '/^cmd_tenant_clients()/,/^cmd_client_secret()/p' '$ROOT/scripts/keycloak.sh'"
  [[ "$output" == *"ensure_client_roles \"\$ui_uuid\" user admin || tenant_failed=1"* ]]
  [[ "$output" == *'if [ "$tenant_failed" -eq 0 ]'* ]]
  [[ "$output" == *'[ "$tenant_failed" -eq 0 ] || return 1'* ]]
}

@test "STATIC: cmd_up aggregates all three local deltas, gates its final banner and return" {
  run bash -c "sed -n '/^cmd_up()/,/^cmd_down()/p' '$ROOT/scripts/local.sh'"
  [[ "$output" == *"local up_failed=0"* ]]
  [[ "$output" == *'up_failed=1'* ]]
  [[ "$output" == *'if [ "$up_failed" -eq 0 ]'* ]]
  [[ "$output" == *'[ "$up_failed" -eq 0 ] || return 1'* ]]
  # All three deltas set it, not just one — the exact count of the shape
  # named in the issue (sslRequired, vault redirect URIs, tenant clients).
  run bash -c "sed -n '/^cmd_up()/,/^cmd_down()/p' '$ROOT/scripts/local.sh' | grep -c 'up_failed=1'"
  [ "$output" -eq 3 ]
}
