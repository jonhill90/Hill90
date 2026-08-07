#!/usr/bin/env bats
#
# h#746: remove_realm_roles()'s three holder-count checks (users, groups,
# composite-parents) each piped `kc get ... | tr -d '\r' | grep -c . ||
# true`. `grep -c .` on empty stdin prints the literal string "0" and exits
# 1 regardless of WHY stdin was empty — a genuine zero-holder result and a
# failed `kc get` (API blip, container restart mid-run) were indistinguishable,
# and `|| true` discarded the difference. On the retirement path that means a
# transient read failure let a role proceed toward `kc delete roles/${role}`
# as if the holder-count had genuinely been verified as zero.
#
# `docker` is stubbed — kc() is a one-line wrapper around
# `docker exec "$KC_CONTAINER" kcadm.sh "$@"` (keycloak.sh:115) — so no real
# Keycloak is involved. These tests call remove_realm_roles() directly.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
}

# $1 = "users-fail" | "groups-fail" | "roles-fail" | "inner-composite-fail" |
#      "has-holders" | "clean"
make_docker_stub() {
  local mode="$1"
  local counter="$BATS_TEST_TMPDIR/roles-call-count"
  echo 0 > "$counter"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
MODE="$mode"
COUNTER="$counter"
args=("\$@")
# args: exec <container> /opt/keycloak/bin/kcadm.sh <subcmd> <target> ...
sub="\${args[3]}"
target="\${args[4]:-}"

case "\$sub \$target" in
  "get roles")
    # remove_realm_roles calls "kc get roles" TWICE: once at the top to
    # check the role still exists, once per role inside the composite-
    # parents check. roles-fail must let the FIRST through (so the loop is
    # reached at all) and fail the SECOND — the one this fix actually
    # guards. inner-composite-fail needs a SECOND role name in both calls
    # so the composite-parents loop below has a candidate other than
    # "admin" itself to iterate over.
    n=\$(cat "\$COUNTER"); n=\$((n + 1)); echo "\$n" > "\$COUNTER"
    if [ "\$MODE" = "roles-fail" ] && [ "\$n" -ge 2 ]; then
      echo "kcadm: connection refused" >&2
      exit 1
    fi
    echo "admin"
    if [ "\$MODE" = "inner-composite-fail" ]; then
      echo "other-role"
    fi
    exit 0
    ;;
  "get roles/admin/users")
    if [ "\$MODE" = "users-fail" ]; then
      echo "kcadm: connection refused" >&2
      exit 1
    fi
    if [ "\$MODE" = "has-holders" ]; then
      echo "user-uuid-1"
    fi
    exit 0
    ;;
  "get roles/admin/groups")
    if [ "\$MODE" = "groups-fail" ]; then
      echo "kcadm: connection refused" >&2
      exit 1
    fi
    exit 0
    ;;
  "get roles/admin/composites")
    exit 0
    ;;
  "get roles/other-role/composites")
    # The residual gap this fix closes: the OUTER "kc get roles" list read
    # (and users/groups) already refused on failure before this fix. This
    # is one level deeper — the PER-CANDIDATE composites lookup inside the
    # loop that builds that same outer list's answer. A real TOCTOU (the
    # candidate role is removed between the outer snapshot and this lookup
    # reaching it) produces exactly this: the outer "get roles" call that
    # named "other-role" already succeeded, but asking for ITS composites
    # now fails.
    if [ "\$MODE" = "inner-composite-fail" ]; then
      echo "kcadm: connection refused" >&2
      exit 1
    fi
    exit 0
    ;;
  "delete roles/admin")
    echo "deleted (0 users, 0 groups, 0 composite parents)" >&2
    exit 0
    ;;
esac
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_remove() {
  cd "$ROOT"
  # shellcheck disable=SC1091
  source scripts/keycloak.sh help >/dev/null 2>&1
  REALM_ROLES_REMOVED=admin remove_realm_roles
}

@test "clean read, zero holders: the role is genuinely deleted" {
  make_docker_stub "clean"
  run run_remove
  [[ "$output" == *"deleted (0 users, 0 groups, 0 composite parents)"* ]]
  [[ "$output" != *"could not read"* ]]
}

@test "clean read, real holders: the role is correctly NOT deleted" {
  make_docker_stub "has-holders"
  run run_remove
  [[ "$output" != *"deleted (0 users, 0 groups, 0 composite parents)"* ]]
  [[ "$output" == *"NOT deleted — holders found"* ]]
}

@test "THE CASE THAT MATTERS: a failed USERS read refuses the delete, names the read failure, not holders" {
  make_docker_stub "users-fail"
  run run_remove
  [[ "$output" != *"deleted (0 users, 0 groups, 0 composite parents)"* ]]
  [[ "$output" == *"could not read current USER holders"* ]]
  [[ "$output" != *"NOT deleted — holders found"* ]]
}

@test "a failed GROUPS read also refuses the delete, distinct message from the users case" {
  make_docker_stub "groups-fail"
  run run_remove
  [[ "$output" != *"deleted (0 users, 0 groups, 0 composite parents)"* ]]
  [[ "$output" == *"could not read current GROUP holders"* ]]
}

@test "a failed realm ROLE LIST read (the composite-parents check's own source) refuses the delete" {
  make_docker_stub "roles-fail"
  run run_remove
  [[ "$output" != *"deleted (0 users, 0 groups, 0 composite parents)"* ]]
  [[ "$output" == *"could not read the realm's role list"* ]]
}

@test "THE RESIDUAL GAP: a failed per-candidate composites read (one level inside the loop) refuses the delete" {
  # This is the case the outer roles-fail test above does NOT cover: the
  # outer "kc get roles" list read succeeds and names "other-role" as a
  # candidate, but asking for THAT role's own composites then fails — a
  # realistic TOCTOU (the candidate is removed between the outer snapshot
  # and this loop reaching it) or a plain network blip on one call among
  # many. Before this fix, a failure here silently contributed nothing to
  # the parents count, exactly like the already-fixed outer reads used to.
  make_docker_stub "inner-composite-fail"
  run run_remove
  [[ "$output" != *"deleted (0 users, 0 groups, 0 composite parents)"* ]]
  [[ "$output" == *"could not read composites for at least one candidate parent role"* ]]
  [[ "$output" != *"NOT deleted — holders found"* ]]
}
