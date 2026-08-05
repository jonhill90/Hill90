#!/usr/bin/env bats

# SSH hardening guards (#539).
#
# Same family as the Traefik config work: a step that runs, reports success,
# and has no effect. The role wrote PasswordAuthentication no into
# /etc/ssh/sshd_config, where the Include at the top of that file causes a
# cloud-init drop-in to win. It survived a full rebuild because nothing ever
# compared intent against the effective configuration.

ROLE=infra/ansible/playbooks/04-ssh-lockdown.yml

@test "hardening is written to a drop-in, not sshd_config" {
  # A value written into sshd_config is read AFTER the Include and loses.
  run grep -F 'dest: /etc/ssh/sshd_config.d/00-hill90-hardening.conf' "$ROLE"
  [ "$status" -eq 0 ]
  # No lineinfile against the main config file.
  run bash -c "grep -A3 'lineinfile:' $ROLE | grep -F 'path: /etc/ssh/sshd_config'"
  [ "$status" -ne 0 ]
}

@test "the drop-in name sorts before cloud-init's" {
  # Drop-ins are read in lexical order and first-match-wins, so the hardening
  # file must sort before 50-cloud-init.conf. A 60- prefix would silently lose.
  # Read the prefix from the dest: line, not from prose — the header comment
  # names 50-cloud-init.conf while explaining the ordering rule.
  run bash -c "grep -E '^ +dest: /etc/ssh/sshd_config\.d/' $ROLE | grep -oE 'sshd_config\.d/[0-9]+' | grep -oE '[0-9]+\$'"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  [ "$((10#$output))" -lt 50 ]
}

@test "the drop-in sets every hardening keyword" {
  for kw in PermitRootLogin PasswordAuthentication PubkeyAuthentication \
            KbdInteractiveAuthentication PermitEmptyPasswords MaxAuthTries; do
    run grep -E "^      ${kw} " "$ROLE"
    [ "$status" -eq 0 ]
  done
}

@test "it uses the modern KbdInteractiveAuthentication keyword" {
  # ChallengeResponseAuthentication is deprecated and newer sshd rejects it,
  # which would make `sshd -t` fail and the drop-in be rolled back.
  run grep -F 'ChallengeResponseAuthentication' "$ROLE"
  [ "$status" -ne 0 ]
  run grep -F 'KbdInteractiveAuthentication no' "$ROLE"
  [ "$status" -eq 0 ]
}

@test "the config is validated before sshd is restarted" {
  # Writing a bad drop-in and restarting would break the only route in.
  run bash -c "
    v=\$(grep -n 'sshd -t' $ROLE | head -1 | cut -d: -f1)
    r=\$(grep -n 'name: Restart sshd' $ROLE | head -1 | cut -d: -f1)
    [ -n \"\$v\" ] && [ -n \"\$r\" ] && [ \"\$v\" -lt \"\$r\" ]
  "
  [ "$status" -eq 0 ]
}

@test "an invalid drop-in is removed rather than left in place" {
  # Left behind, it would break the next restart by anything at all.
  run grep -F 'name: Remove the drop-in if it produced an invalid configuration' "$ROLE"
  [ "$status" -eq 0 ]
  run bash -c "grep -A3 'Remove the drop-in if it produced' $ROLE | grep -F 'state: absent'"
  [ "$status" -eq 0 ]
}

@test "the role verifies intent against the effective configuration" {
  # The defect was invisible to file inspection. Only `sshd -T` shows it.
  run grep -F 'sshd -T' "$ROLE"
  [ "$status" -eq 0 ]
  run bash -c "grep -c \"in sshd_effective.stdout_lines\" $ROLE"
  [ "$output" -ge 6 ]
}

@test "the verification asserts password auth is off" {
  run grep -F "'passwordauthentication no' in sshd_effective.stdout_lines" "$ROLE"
  [ "$status" -eq 0 ]
}

@test "no task in the role silently ignores its own failure" {
  # `ignore_errors: yes` on the fail2ban tasks is why the docs claimed a service
  # that was never installed. The cloud-init task uses failed_when: false, which
  # is scoped to one optional file rather than blanket.
  run bash -c "grep -c 'ignore_errors: yes' $ROLE"
  [ "$output" -eq 0 ]
}

@test "fail2ban is not claimed anywhere it is not installed" {
  # It is in no repository enabled on the host, so the tasks could never succeed.
  run bash -c "grep -E '^[^#]*fail2ban' $ROLE"
  [ "$status" -ne 0 ]
  run bash -c "grep -E '^[^#]*fail2ban' infra/ansible/playbooks/bootstrap.yml"
  [ "$status" -ne 0 ]
  run bash -c "grep -iE '^[^#>]*fail2ban is enabled' docs/architecture/security.md"
  [ "$status" -ne 0 ]
}

@test "THE ASSERTION THAT MATTERS: the key gate runs before any sshd-config-changing task, and stays there on reorder" {
  # #786: 01-system-prep.yml copies authorized_keys with ignore_errors: yes
  # (deliberately tolerant — not every provider puts the key there), which
  # means nothing downstream can assume that copy worked. This role is what
  # turns a missing key into an unreachable host, so it must refuse to
  # proceed before it touches sshd at all. Line-number comparison, not a
  # substring check, so a future reorder that puts the gate after the
  # firewalld/sshd tasks fails this test even though every individual task
  # still exists.
  run bash -c "
    gate=\$(grep -n 'name: Refuse to proceed without a usable key' $ROLE | head -1 | cut -d: -f1)
    firewall=\$(grep -n 'name: Lock SSH to Tailscale network only' $ROLE | head -1 | cut -d: -f1)
    dropin=\$(grep -n 'name: Deploy SSH hardening drop-in' $ROLE | head -1 | cut -d: -f1)
    restart=\$(grep -n 'name: Restart sshd to apply the drop-in' $ROLE | head -1 | cut -d: -f1)
    [ -n \"\$gate\" ] && [ -n \"\$firewall\" ] && [ -n \"\$dropin\" ] && [ -n \"\$restart\" ] \
      && [ \"\$gate\" -lt \"\$firewall\" ] && [ \"\$gate\" -lt \"\$dropin\" ] && [ \"\$gate\" -lt \"\$restart\" ]
  "
  [ "$status" -eq 0 ]
}

@test "the key gate checks existence, regular-file-ness, and non-zero size — not just existence" {
  # A zero-byte authorized_keys (truncated write, empty upload) passes an
  # exists-only check but leaves the account with no usable key.
  run bash -c "grep -A6 'name: Refuse to proceed without a usable key' $ROLE | grep -F 'deploy_authorized_keys.stat.exists'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A6 'name: Refuse to proceed without a usable key' $ROLE | grep -F 'deploy_authorized_keys.stat.isreg'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A6 'name: Refuse to proceed without a usable key' $ROLE | grep -F 'deploy_authorized_keys.stat.size > 0'"
  [ "$status" -eq 0 ]
}

@test "the key gate's failure message names the actual consequence, not a generic error" {
  run bash -c "grep -A20 'name: Refuse to proceed without a usable key' $ROLE | grep -iF 'UNREACHABLE'"
  [ "$status" -eq 0 ]
}

@test "a standalone verifier exists and is read-only" {
  [ -x scripts/verify-ssh-hardening.sh ]
  run bash -n scripts/verify-ssh-hardening.sh
  [ "$status" -eq 0 ]
  # It must not modify anything: no writes, restarts, or config edits.
  run bash -c "grep -nE '(^|[^-])(systemctl (restart|start|stop)|sshd -t -f|tee |> */etc/|sed -i)' scripts/verify-ssh-hardening.sh"
  [ "$status" -ne 0 ]
}

@test "the verifier checks the effective config, not the files" {
  run grep -F 'sshd -T' scripts/verify-ssh-hardening.sh
  [ "$status" -eq 0 ]
  run bash -c "grep -c '^check ' scripts/verify-ssh-hardening.sh"
  [ "$output" -ge 6 ]
}
