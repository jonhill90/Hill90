#!/usr/bin/env bats

# ops.sh's host-invariant checks.
#
# These exist because SSH password authentication was enabled on the running host
# for weeks while the repo, the playbook and docs/architecture/security.md all
# said it was off. Nothing noticed because nothing looked.
#
# The behaviour under test is the three-state verdict, and specifically that it
# FLIPS BY ITSELF once the hardening is installed — nobody has to remember to
# change a threshold:
#
#   effective `no`                       -> pass
#   effective `yes`, drop-in ABSENT      -> warn, exit 0  (known, accepted, not yet applied)
#   effective `yes`, drop-in PRESENT     -> FAIL, exit 1  (installed and being overridden)
#
# Everything is stubbed, so no host is touched and no root is needed.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  STUB="${BATS_TEST_TMPDIR}/bin"; mkdir -p "$STUB"
  PATH="${STUB}:$PATH"

  # Defaults: the healthy host. Individual tests override before running.
  export FIX_PWAUTH=no
  export FIX_ROOTLOGIN=no
  export FIX_DROPIN=absent
  export FIX_PUBSSH=no
  export FIX_UNIT=enabled
  export FIX_SUDO=ok

  cat > "${STUB}/sudo" <<'SH'
#!/usr/bin/env bash
[ "$1" = "-n" ] && shift
case "$1" in
  true)  [ "${FIX_SUDO}" = "ok" ] && exit 0 || exit 1 ;;
  test)  # `test -f <dropin>`
         [ "${FIX_DROPIN}" = "present" ] && exit 0 || exit 1 ;;
  */sshd|sshd)
         printf 'passwordauthentication %s\n' "${FIX_PWAUTH}"
         printf 'permitrootlogin %s\n' "${FIX_ROOTLOGIN}"
         printf 'pubkeyauthentication yes\n'
         exit 0 ;;
  firewall-cmd)
         printf '%s\n' "${FIX_PUBSSH}"; exit 0 ;;
esac
exit 0
SH

  cat > "${STUB}/systemctl" <<'SH'
#!/usr/bin/env bash
[ "$1" = "is-enabled" ] && { printf '%s\n' "${FIX_UNIT}"; exit 0; }
exit 0
SH
  chmod +x "${STUB}/sudo" "${STUB}/systemctl"
}

# Run just the function, without ops.sh's dispatcher.
run_invariants() {
  run bash -c "
    source <(sed -n '/^check_host_invariants()/,/^}/p' '${REPO_ROOT}/scripts/ops.sh')
    check_host_invariants
  "
}

@test "a hardened host passes" {
  run_invariants
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ disabled"* ]]
  [[ "$output" == *"✓ closed"* ]]
  [[ "$output" == *"✓ enabled"* ]]
}

@test "password auth on with NO drop-in warns, and does not fail the run" {
  FIX_PWAUTH=yes FIX_DROPIN=absent run_invariants
  [ "$status" -eq 0 ]
  [[ "$output" == *"⚠"* ]]
  [[ "$output" == *"not applied to this host yet"* ]]
  [[ "$output" == *"ssh-hardening-drop-in.md"* ]]
}

@test "password auth on WITH the drop-in present is a failure" {
  # The flip. Once the hardening is installed, the same effective value stops
  # being an accepted state and becomes a regression — no threshold to remember.
  FIX_PWAUTH=yes FIX_DROPIN=present run_invariants
  [ "$status" -eq 1 ]
  [[ "$output" == *"despite the hardening drop-in being present"* ]]
}

@test "the assertion reads sshd -T, not a file or sshd_config" {
  # The original defect was a file that said the right thing while the daemon did
  # the opposite. A check that greps the file would have reported healthy all
  # along, so pin that it consults the effective configuration.
  run bash -c "sed -n '/^check_host_invariants()/,/^}/p' '${REPO_ROOT}/scripts/ops.sh'"
  [[ "$output" == *"sshd -T"* ]]
  ! grep -qE "grep .*sshd_config" <<< "$output"
}

@test "root login permitted is a failure" {
  FIX_ROOTLOGIN=yes run_invariants
  [ "$status" -eq 1 ]
  [[ "$output" == *"permitted"* ]]
}

@test "ssh open on the public zone is a failure" {
  FIX_PUBSSH=yes run_invariants
  [ "$status" -eq 1 ]
  [[ "$output" == *"OPEN"* ]]
}

@test "the vault auto-unseal unit being disabled is a failure" {
  FIX_UNIT=disabled run_invariants
  [ "$status" -eq 1 ]
  [[ "$output" == *"sealed after a reboot"* ]]
}

@test "an absent unit warns rather than failing" {
  # Not every host runs vault. Absent is not the same as disabled.
  FIX_UNIT="" run_invariants
  [ "$status" -eq 0 ]
  [[ "$output" == *"not installed"* ]]
}

@test "without non-interactive root it reports that it could not check" {
  # A check that cannot run must not report the thing it checks as healthy, and
  # must not report it as broken either.
  FIX_SUDO=denied run_invariants
  [ "$status" -eq 0 ]
  [[ "$output" == *"Cannot check host invariants"* ]]
  [[ "$output" != *"✓ disabled"* ]]
}
