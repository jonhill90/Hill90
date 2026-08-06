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
  # No lineinfile against the MAIN config file specifically — anchored to
  # end-of-line so this does not also match a legitimate lineinfile against
  # a *drop-in* (sshd_config.d/50-cloud-init.conf), which h#786 deliberately
  # added and is a different file entirely from the main config.
  run bash -c "grep -A3 'lineinfile:' $ROLE | grep -E 'path: /etc/ssh/sshd_config\$'"
  [ "$status" -ne 0 ]
}

@test "h#786: cloud-init's own drop-in is corrected at its source, not just out-ranked by sort order" {
  # The 00- drop-in winning by lexical order is real but was flagged in
  # review as a fix that works by luck of filename ordering rather than by
  # construction. This pins the stronger fix alongside it: a lineinfile task
  # that corrects PasswordAuthentication directly inside
  # /etc/ssh/sshd_config.d/50-cloud-init.conf, so this keyword no longer
  # depends on which file sorts first at all.
  run bash -c "grep -A6 'name: Correct PasswordAuthentication directly in cloud' $ROLE | grep -F 'path: /etc/ssh/sshd_config.d/50-cloud-init.conf'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A6 'name: Correct PasswordAuthentication directly in cloud' $ROLE | grep -F 'line: '\''PasswordAuthentication no'\'''"
  [ "$status" -eq 0 ]
  # Absence of the file must not be an error — not every image ships it.
  run bash -c "grep -A8 'name: Correct PasswordAuthentication directly in cloud' $ROLE | grep -F 'failed_when: false'"
  [ "$status" -eq 0 ]
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

@test "the config is validated before sshd is reloaded" {
  # Writing a bad drop-in and reloading would break the only route in.
  run bash -c "
    v=\$(grep -n 'sshd -t' $ROLE | head -1 | cut -d: -f1)
    r=\$(grep -n 'name: Reload sshd' $ROLE | head -1 | cut -d: -f1)
    [ -n \"\$v\" ] && [ -n \"\$r\" ] && [ \"\$v\" -lt \"\$r\" ]
  "
  [ "$status" -eq 0 ]
}

@test "h#786: sshd is reloaded, not restarted — none of these keywords need a full restart" {
  # A restart would drop the very connection this playbook might be running
  # over, if it happens to be a plain-sshd session rather than Tailscale SSH.
  # Reload (SIGHUP) re-reads config without dropping established sessions,
  # and every keyword this role sets supports it.
  run grep -F 'name: Reload sshd to apply the drop-in' "$ROLE"
  [ "$status" -eq 0 ]
  run bash -c "grep -A3 'name: Reload sshd to apply the drop-in' $ROLE | grep -F 'state: reloaded'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A3 'name: Reload sshd to apply the drop-in' $ROLE | grep -F 'state: restarted'"
  [ "$status" -ne 0 ]
  # The operator note belongs in the file, not only in a PR description.
  run grep -iF 'keep your current session open' "$ROLE"
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
    restart=\$(grep -n 'name: Reload sshd to apply the drop-in' $ROLE | head -1 | cut -d: -f1)
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

# ---------------------------------------------------------------------------
# GATE 2 (h#787): a file existing is not proof sshd will accept it.
#
# The original gate (#786/#539, tested above) only proves authorized_keys is
# a non-empty regular file. Wrong ownership, wrong permissions, an SELinux
# context mismatch, or sshd config pointing elsewhere can each leave a
# correctly-copied, non-empty key file completely unusable — exactly the
# case a file-existence check waves through. GATE 2 proves the ACCESS
# MECHANISM itself: it appends a throwaway keypair to the same file at the
# same path, attempts a real authenticated SSH connection as the deploy
# user over loopback, and refuses to proceed if that connection fails.
#
# These are structural/static checks, same reasoning and same limits as the
# tests above — they cannot exercise a real sshd from bats. That exercise
# was done separately, manually, against a disposable AlmaLinux container
# with a real sshd (never the production VPS, per h#787's explicit
# instruction): the real extracted task block from this file authenticated
# successfully against a correctly-owned key, and correctly REFUSED against
# a file that existed, was a regular file, and was non-empty, but was owned
# by root instead of deploy — the exact case GATE 1 alone would wave
# through. See the PR description for the full commands and captured
# output.
# ---------------------------------------------------------------------------

@test "GATE 2 exists and runs before GATE 1's sibling firewalld/sshd tasks" {
  run bash -c "
    gate2=\$(grep -n 'name: Prove an authenticated SSH connection as the deploy user actually works' $ROLE | head -1 | cut -d: -f1)
    refuse2=\$(grep -n 'name: Refuse to proceed unless the probe connection actually authenticated' $ROLE | head -1 | cut -d: -f1)
    firewall=\$(grep -n 'name: Lock SSH to Tailscale network only' $ROLE | head -1 | cut -d: -f1)
    dropin=\$(grep -n 'name: Deploy SSH hardening drop-in' $ROLE | head -1 | cut -d: -f1)
    [ -n \"\$gate2\" ] && [ -n \"\$refuse2\" ] && [ -n \"\$firewall\" ] && [ -n \"\$dropin\" ] \
      && [ \"\$gate2\" -lt \"\$refuse2\" ] && [ \"\$refuse2\" -lt \"\$firewall\" ] && [ \"\$refuse2\" -lt \"\$dropin\" ]
  "
  [ "$status" -eq 0 ]
}

@test "GATE 2 attempts a REAL ssh connection, not another stat" {
  run bash -c "grep -A40 'name: Prove an authenticated SSH connection' $ROLE | grep -E '^\s+ssh -i '"
  [ "$status" -eq 0 ]
  run bash -c "grep -A40 'name: Prove an authenticated SSH connection' $ROLE | grep -F 'BatchMode=yes'"
  [ "$status" -eq 0 ]
}

@test "GATE 2 targets loopback, never the tailnet — Tailscale SSH must not be able to mask a broken key" {
  # If this probed over the tailnet, Tailscale SSH (up since 03-tailscale.yml,
  # authorises by tailnet ACL, never reads authorized_keys) could answer the
  # connection and the gate would pass regardless of whether OpenSSH's own
  # key path works at all — silently proving nothing.
  run bash -c "grep -A40 'name: Prove an authenticated SSH connection' $ROLE | grep -F '127.0.0.1'"
  [ "$status" -eq 0 ]
}

@test "GATE 2's probe key is generated fresh, never uses a real operator key" {
  # There is no private key on the host to test with — only the public half
  # was ever copied there. A throwaway keypair is the only way to test the
  # mechanism without needing operator secrets.
  run bash -c "grep -A10 'name: Generate a throwaway keypair' $ROLE | grep -F 'ssh-keygen -t ed25519'"
  [ "$status" -eq 0 ]
}

@test "GATE 2 cleans up the probe key unconditionally, via block/always — not two independent tasks" {
  # A bare task pair would leave the throwaway key behind on any failure
  # between appending it and removing it — a self-inflicted extra
  # authorized key on a host this play is about to lock down.
  run bash -c "grep -A60 'name: Prove an authenticated SSH connection as the deploy user actually works' $ROLE | grep -m1 '^  block:'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A60 'name: Prove an authenticated SSH connection as the deploy user actually works' $ROLE | grep -m1 '^  always:'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A80 '^  always:' $ROLE | grep -c 'name: Remove the probe'"
  [ "$output" -ge 2 ]
}

@test "GATE 2 refuses on the connection's own exit code, not on the append task's success" {
  # The append (lineinfile) succeeding proves nothing about whether sshd
  # will honour the result — that is exactly GATE 1's blind spot. The
  # refusal must key off the SSH command's own rc.
  run bash -c "grep -A5 'name: Refuse to proceed unless the probe connection actually authenticated' $ROLE | grep -F 'gate_connection.rc == 0'"
  [ "$status" -eq 0 ]
}

@test "GATE 2's failure message distinguishes itself from GATE 1's — names mechanism causes, not just 'missing'" {
  run bash -c "grep -A25 'name: Refuse to proceed unless the probe connection actually authenticated' $ROLE | grep -iF 'ownership'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A25 'name: Refuse to proceed unless the probe connection actually authenticated' $ROLE | grep -iF 'SELinux'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A25 'name: Refuse to proceed unless the probe connection actually authenticated' $ROLE | grep -iF 'StrictModes'"
  [ "$status" -eq 0 ]
}
