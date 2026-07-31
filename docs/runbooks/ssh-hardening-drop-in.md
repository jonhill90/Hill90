# Applying the SSH hardening drop-in

**Status: not applied to the running host. This page exists so the decision to
apply it can be taken safely, not to argue that it should be taken now.**

`Measured 2026-07-31.` The repository carries the fix; this host has never
received it. Applying it means running **Config VPS**, which restarts `sshd` on a
machine reachable only over the tailnet — so the failure mode is losing access to
it. That is Jon's decision and Jon's timing.

---

## What is actually true today

**The documented hardening is not in force. The host is not exposed.** Both
halves matter and the record should keep them together.

| | Effective now | Why it is not an exposure |
|---|---|---|
| `passwordauthentication` | **yes** | no account can use it — see below |
| `permitrootlogin` | no | root cannot SSH at all |
| `pubkeyauthentication` | yes | how we actually connect |
| `kbdinteractiveauthentication` | no | |
| `permitemptypasswords` | no | |
| `maxauthtries` | 3 | |

Five of the six asserted values are already correct. Only password
authentication is wrong, and it is **unusable**:

- **`root` has a password but cannot SSH** — `PermitRootLogin no`.
- **`deploy` can SSH but has no password** — its `/etc/shadow` entry carries no
  usable hash, so there is nothing to guess.
- **SSH is not reachable from the public internet.** `sshd` listens on
  `0.0.0.0:22`, but firewalld's `public` zone on `eth0` permits only
  `cockpit/dhcpv6-client/http/https`, and a rich rule admits `ssh` from
  `100.64.0.0/10` only. Reachability is over the tailnet.
- **Login history is quiet.** The last interactive login was `deploy` on
  **2026-07-13** from a tailnet address; the only `root` logins were 2026-06-14
  from a public address during the initial build. `lastb` records **no failed
  attempts since 2026-07-01**.

So: a hardening control is documented and not enforced. Nothing has been
exposed, and nothing needs rotating.

### Why it is like this

`sshd` takes the **first** value it sees for a keyword. `/etc/ssh/sshd_config`
includes `sshd_config.d/*.conf` near the top, and the cloud image ships
`50-cloud-init.conf` containing `PasswordAuthentication yes`. The `no` at
`sshd_config:64` is never reached. `04-ssh-lockdown.yml` fixes this by writing
`00-hill90-hardening.conf`, which sorts first — that file is simply not on this
host yet.

## What Config VPS would actually change

Measured against the live host rather than inferred from the playbook. **Two
files created, one service restarted.** Everything else in the SSH role is
already in its target state:

| Task | Current state | Would change? |
|---|---|---|
| firewalld rich rule, ssh from `100.64.0.0/10` | **already present** | no |
| remove `ssh` service from the public zone | **already absent** | no |
| write `/etc/ssh/sshd_config.d/00-hill90-hardening.conf` | **absent** | **CREATE** |
| write `/etc/cloud/cloud.cfg.d/99-hill90-ssh.cfg` (`ssh_pwauth: false`) | **absent** | **CREATE** |
| restart `sshd` | running | **RESTART** (only because the drop-in changed) |
| assert against `sshd -T` | 5 of 6 correct | passes after the above |

**But Config VPS runs the whole bootstrap**, not just the SSH role — `01-08`
plus `11` and `12`. You cannot run the SSH piece alone through the workflow.
The others were checked and are guarded:

- **01 system-prep** — `dnf: state: present`, not `latest`. No upgrades, no reboot.
- **03 tailscale** — `tailscale up` is gated on `when: 'Logged out' in status or rc != 0`. An already-authenticated node is left alone. **This matters: a re-auth would drop the tailnet, which is the path you are standing on.**
- **05 docker** — repo add guarded by `creates:`, package `state: present`. **It does not restart Docker**, so containers are not disturbed.
- **11 vault-unseal** — installs the unit file; harmless if unchanged.

Idempotent overall: on a host already in the target state the play should report
no changes beyond the two files and the one restart.

## Break-glass, if sshd comes back refusing the key

**There is a path that does not involve `sshd` at all, and it is the reason this
change is safer than it looks.**

1. **The session you kept open.** Free, and the reason for the procedure below.
2. **Tailscale SSH.** `RunSSH: True` on this node, served by `tailscaled` — not
   OpenSSH — so an sshd misconfiguration cannot close it. The tailnet ACL permits
   it: `autogroup:admin → tag:vps` as `root`, `deploy` or `autogroup:nonroot`.
   ```bash
   tailscale ssh deploy@hill90-vps     # or root@, which the ACL also allows
   ```
   **Verified as configuration** — `RunSSH: True`, a `tailscaled` listener, and
   the ACL rule. **Not exercised.** Doing so is a one-command rehearsal and is
   worth doing *before* the change rather than during an incident.
3. **Hostinger snapshot restore** — `bash scripts/hostinger.sh vps snapshot restore`,
   per [vps-rebuild.md](vps-rebuild.md). Destroys anything since the snapshot, so
   confirm one exists and note its age **before** starting.
4. **Provider browser console.** Hostinger's hPanel offers one. It is **not**
   exposed through `scripts/hostinger.sh`, and there is **no record in this
   repository of it ever having been used**. Treat it as untested.
5. **`hostinger.sh vps recreate`** — a full rebuild. Last resort, not recovery.

The playbook also protects itself: it runs `sshd -t` against the **full effective
configuration** before restarting, removes its own drop-in and fails loudly if
that validation fails, and restarts only when the file actually changed. A
syntactically broken config therefore cannot reach a restart.

## How to verify without locking yourself out

The rule: **never close the connection you have until a new one works.**

```bash
# Terminal A — the lifeline. Open it first and DO NOT CLOSE IT.
ssh vps
#   leave this sitting at a shell for the whole procedure.

# Optional but recommended: rehearse the break-glass path before you need it.
tailscale ssh deploy@hill90-vps 'echo tailscale-ssh works'

# Pre-flight, in terminal A:
sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|pubkeyauthentication)'
bash scripts/hostinger.sh vps snapshot get     # confirm a snapshot exists, note its age

# Then run Config VPS from your workstation, NOT from terminal A:
gh workflow run "Config VPS (OS Configuration Only)" -f vps_ip=<ip>
gh run watch <id>

# Terminal B — a NEW connection, opened while A is still alive:
ssh vps 'sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin)"'
#   expect: passwordauthentication no
#           permitrootlogin no

# Only when terminal B has succeeded, close terminal A.
```

If terminal B fails, **do not close terminal A.** From it:

```bash
sudo rm /etc/ssh/sshd_config.d/00-hill90-hardening.conf
sudo sshd -t && sudo systemctl restart sshd     # validate BEFORE restarting
```

That returns the host to exactly its present state, which is a working one.

There is also `sudo bash scripts/verify-ssh-hardening.sh`, which checks the
effective configuration rather than the files.

## Durability: this does not stay fixed by itself

**Ordering is not the whole mechanism, and that is deliberate.** The playbook
does two independent things:

1. Writes `00-hill90-hardening.conf`, which sorts before `50-cloud-init.conf`.
2. Writes `/etc/cloud/cloud.cfg.d/99-hill90-ssh.cfg` with `ssh_pwauth: false`, so
   cloud-init stops asserting the opposite at all.

**If cloud-init ever renames its drop-in, mechanism 1 silently fails.** Drop-ins
are read in lexical order and the first value wins, so any name sorting before
`00-hill90-hardening.conf` — `00-cloud-init.conf`, `00-a…`, anything up to
`00-h…` — would take precedence again. Nothing would error; `sshd -T` would just
quietly report `yes` once more. Mechanism 2 is what makes that survivable,
because cloud-init would no longer be writing the setting in the first place.

Note the second task carries `failed_when: false` (cloud-init is not on every
image), so a failure to write it is **not** loud. Mechanism 2 is the safety net
and it is the one that can fail quietly.

**And there is a gap between runs.** The `sshd -T` assertion only executes during
a bootstrap. `scripts/ops.sh health` does **not** check sshd, so a regression
between Config VPS runs would go unnoticed. The cheap durable improvement is to
add the effective-config assertion to the routine health check, so drift is
detected without needing a bootstrap. That is a separate, low-risk change and is
not required to apply the hardening.

**A rebuild re-runs the bootstrap**, so a rebuilt host gets the drop-in as part
of Config VPS. The recurrence risk is not the rebuild; it is a cloud-init
release changing its filename between rebuilds.

## Recommendation

Apply it, at a time of Jon's choosing, using the two-terminal procedure — and
rehearse `tailscale ssh` first, because a break-glass path that has never been
exercised is a hypothesis.

It is **not urgent**. Nothing is exposed, no credential needs rotating, and the
control's absence is documented. What it buys is that the documented posture and
the running posture stop disagreeing — which is worth having before the next
person reads `security.md` and believes it.
