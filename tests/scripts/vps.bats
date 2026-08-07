#!/usr/bin/env bats

# Tests for scripts/vps.sh CLI

@test "vps.sh with no args shows usage" {
  run bash scripts/vps.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "vps.sh help shows usage" {
  run bash scripts/vps.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "vps.sh invalid subcommand fails" {
  run bash scripts/vps.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "vps.sh config without IP fails" {
  run bash scripts/vps.sh config
  [ "$status" -eq 1 ]
  [[ "$output" == *"required"* ]] || [[ "$output" == *"Usage"* ]]
}

# ---------------------------------------------------------------------------
# h#681 / h#786: harden-ssh — narrow re-apply of firewall + SSH hardening
# only, without the rest of bootstrap.yml's blast radius (03-tailscale,
# 05-docker). cmd_harden_ssh is stubbed here, not run for real — sops and
# ansible-playbook are replaced with recording stubs so these tests prove
# the COMMAND'S OWN LOGIC (which flags reach ansible-playbook, which mode
# is reported) without ever touching a real secrets store or a real host.
# ---------------------------------------------------------------------------

setup_harden_ssh_stubs() {
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"

  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
echo "203.0.113.10"
EOF
  chmod +x "$STUB/sops"

  cat > "$STUB/ansible-playbook" <<EOF
#!/usr/bin/env bash
echo "\$@" > "$BATS_TEST_TMPDIR/ansible-playbook.args"
exit 0
EOF
  chmod +x "$STUB/ansible-playbook"

  # load_secrets is skipped entirely when this is already set — cmd_harden_ssh
  # only needs the second, direct `sops --extract TAILSCALE_IP` call, which
  # the stub above answers regardless of which secrets file is asked for.
  export TAILSCALE_AUTH_KEY=stub-not-a-real-key
}

@test "vps.sh help mentions harden-ssh and --check" {
  run bash scripts/vps.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"harden-ssh"* ]]
  [[ "$output" == *"--check"* ]]
}

@test "harden-ssh rejects an unknown option before touching secrets or the network" {
  # No stubs installed on purpose — if this reached load_secrets/sops/ansible
  # at all, it would fail on a missing age key or real sops, not on this
  # assertion. Failing fast on option parsing means it does neither.
  run bash scripts/vps.sh harden-ssh --bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown option"* ]]
  [[ "$output" == *"--check"* ]]
}

@test "harden-ssh (apply mode) invokes ansible-playbook WITHOUT --check" {
  setup_harden_ssh_stubs
  run bash scripts/vps.sh harden-ssh
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/ansible-playbook.args" ]
  run cat "$BATS_TEST_TMPDIR/ansible-playbook.args"
  [[ "$output" != *"--check"* ]]
  [[ "$output" == *"playbooks/ssh-harden.yml"* ]]
  [[ "$output" == *"ansible_user=deploy"* ]]
}

@test "harden-ssh --check invokes ansible-playbook WITH --check --diff, same playbook" {
  setup_harden_ssh_stubs
  run bash scripts/vps.sh harden-ssh --check
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/ansible-playbook.args" ]
  run cat "$BATS_TEST_TMPDIR/ansible-playbook.args"
  [[ "$output" == *"--check"* ]]
  [[ "$output" == *"--diff"* ]]
  [[ "$output" == *"playbooks/ssh-harden.yml"* ]]
}

@test "harden-ssh --dry-run is accepted as a synonym for --check" {
  setup_harden_ssh_stubs
  run bash scripts/vps.sh harden-ssh --dry-run
  [ "$status" -eq 0 ]
  run cat "$BATS_TEST_TMPDIR/ansible-playbook.args"
  [[ "$output" == *"--check"* ]]
}

@test "harden-ssh (apply mode) warns to keep the session open before reloading" {
  setup_harden_ssh_stubs
  run bash scripts/vps.sh harden-ssh
  [[ "$output" == *"Keep this session open"* ]]
}

@test "harden-ssh --check does NOT print the keep-this-session-open warning — nothing is being reloaded" {
  setup_harden_ssh_stubs
  run bash scripts/vps.sh harden-ssh --check
  [[ "$output" != *"Keep this session open"* ]]
}

@test "harden-ssh connects as deploy, never root — root login is refused on an already-hardened host" {
  setup_harden_ssh_stubs
  run bash scripts/vps.sh harden-ssh
  run cat "$BATS_TEST_TMPDIR/ansible-playbook.args"
  [[ "$output" == *"ansible_user=deploy"* ]]
  [[ "$output" != *"ansible_user=root"* ]]
}

@test "harden-ssh refuses cleanly when no TAILSCALE_IP is recorded — never calls ansible-playbook" {
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
echo ""
EOF
  chmod +x "$STUB/sops"
  cat > "$STUB/ansible-playbook" <<EOF
#!/usr/bin/env bash
echo "SHOULD NOT HAVE BEEN CALLED" > "$BATS_TEST_TMPDIR/ansible-playbook.called"
exit 0
EOF
  chmod +x "$STUB/ansible-playbook"
  export TAILSCALE_AUTH_KEY=stub-not-a-real-key

  run bash scripts/vps.sh harden-ssh
  [ "$status" -eq 1 ]
  [[ "$output" == *"No TAILSCALE_IP recorded"* ]]
  [ ! -f "$BATS_TEST_TMPDIR/ansible-playbook.called" ]
}
