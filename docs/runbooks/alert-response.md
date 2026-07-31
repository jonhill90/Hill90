# Alert response — the first three minutes

**This page is an index, not a manual.** Find your symptom, do the three steps,
follow the link if it is not resolved. Everything below fits on one screen on
purpose: a runbook nobody finishes at 3am is worse than four lines that get
followed.

**Two things are true of nearly every alert here.** Most of them are not
emergencies — the estate is built with days of margin, and the alert usually
means *a safety net has failed*, not *the service is down*. And the instinctive
fix is frequently the wrong one: restarting the thing, forcing the renewal,
freeing the disk. Each entry names the one to avoid.

Start here if you have no idea which:

```bash
ssh vps 'cd /opt/hill90/app && bash scripts/ops.sh health'
```

(`scripts/ops.sh`, not `make health` — **`make` is not installed on the VPS**.
The Makefile target is for a workstation, and the check itself needs Docker
access on the host.)

That covers containers, routed surfaces, DNS, and the host invariants (SSH
hardening, public SSH closed, vault auto-unseal enabled). A green run rules out a
great deal in ten seconds.

---

## Certificate expiring — `CertificateExpiringSoon` / `Critical`

**Not urgent. You have at least 21 days, by design.** The threshold sits nine
days into a thirty-day renewal window, so this fires long before anything breaks.

1. **How many, and which?** If several DNS-01 hosts are falling together —
   `traefik`, `portainer`, `grafana`, `vault`, `litellm`, `storage` — they share
   one Cloudflare token and one store. That is a different problem from one
   certificate failing alone.
2. **What did Traefik actually try?** Grep for `challenge`, not just
   `certificate` — a revoked token fails as a *DNS challenge* error, so the
   obvious grep returns nothing and looks like silence.
3. **Is the credential still there?** A revoked or expired `CF_DNS_API_TOKEN`
   stops all six DNS-01 renewals at once and touches none of the HTTP-01 ones.

```bash
docker exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=(traefik_tls_certs_not_after-time())/86400'
docker logs traefik --since 48h 2>&1 | grep -iE 'acme|challenge|certificate' | tail -30
```

**Do not force a renewal, and do not delete `acme-dns.json`.** It holds the ACME
account key and all six DNS-01 certificates; deleting it forces re-registration
straight into Let's Encrypt's rate limits — five duplicate certificates per week —
at the moment you least want to be blocked. Restarting Traefik to trigger an
attempt is a deliberate act, not a debugging reflex: it is the component every
service sits behind.

→ [certificate-renewal.md](certificate-renewal.md)

---

## Vault sealed — after a reboot, or `hill90-vault-unseal` failed

**A sealed vault does not take the estate down.** Deploys are vault-first with a
SOPS fallback, so this degrades rather than breaks. Fix it in the morning unless
something else is also failing.

1. **Ask the unit, not the container.** Its state distinguishes the two cases that
   look identical from outside: it *ran and failed*, or it *never ran*.
2. **Read why.** The unit waits up to 120s for the container and 60s more for the
   API, and retries three times before giving up — so the journal usually names
   the thing it was waiting for.
3. **Unseal by hand** once the cause is understood.

```bash
systemctl status hill90-vault-unseal            # active(exited)=ok, failed=tried and lost
journalctl -u hill90-vault-unseal -b --no-pager
docker exec openbao bao status | grep -E '^(Initialized|Sealed)'
cd /opt/hill90/app && bash scripts/vault.sh unseal
```

**Do not restart the OpenBao container.** It comes back sealed — restarting is
what people reach for and it achieves nothing except a longer outage. The unseal
key is already on the host at `/opt/hill90/secrets/openbao-unseal.key`, with a
SOPS fallback; the problem is almost never the key.

→ [vault-unseal.md](vault-unseal.md)

---

## Backup absent — `BackupNotSucceeding` / `BackupSignalMissing`

**This is not data loss.** Previous nights' backups are on disk and restorable. A
single missed night can wait until morning; two consecutive nights cannot.

1. **Did it run at all?** This is the branch that matters. No entry for last night
   means cron did not fire — a different fault from the backup failing.
2. **Which target?** One container being legitimately absent is a *known* case:
   the script continues deliberately so one missing tenant does not cost the other
   five their backups, then fails the run at the end.
3. **Re-run by hand** once the cause is fixed.

```bash
sudo tail -40 /opt/hill90/backups/cron.log      # nothing for last night => cron, not backup
sudo -u deploy crontab -l                       # 0 3 * * * backup-all
cd /opt/hill90/app && bash scripts/backup.sh backup-all
```

**Do not prune old backups to free space.** If `DiskSpaceRunningLow` is firing
alongside this, the instinct is to make room by deleting the oldest artifacts —
which destroys the recovery position at the exact moment it is most likely to be
needed. Free space somewhere else first.

→ [../reference/backup-coverage.md](../reference/backup-coverage.md),
[disaster-recovery.md](disaster-recovery.md)

---

## Site down — `ServiceDown`, or a report from a human

**Read the alert carefully first.** `ServiceDown` means a *scrape target* stopped
answering Prometheus. That is not the same as the public site being down, and the
reverse is also true: **nothing currently probes `hill90.com` from outside**, so
the site can be unreachable to visitors while every alert stays quiet.

1. **Is it actually down, and for whom?** From outside, then from the host. If the
   host says 200 and the outside says otherwise, it is DNS or the network, not the
   app.
2. **Which layer?** Traefik answering at all separates an edge problem from a
   backend one.
3. **Then look at the container**, not before — the previous two steps take
   seconds and change what the logs mean.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://hill90.com/          # from your machine
ssh vps 'curl -s -o /dev/null -w "%{http_code}\n" https://hill90.com/'
ssh vps 'docker ps --filter health=unhealthy --format "{{.Names}}"'
```

**Do not redeploy the edge as a first move.** Restarting Traefik drops every
in-flight connection across every service, and if the cause is DNS, an expired
certificate or a single backend, it changes nothing while making the logs harder
to read.

→ [troubleshooting.md](troubleshooting.md),
[../decisions/alerting-audit.md](../decisions/alerting-audit.md)

---

## What is not wired up yet

Honest, because an index that implies coverage it does not have is worse than
none:

- **No delivery path exists.** Prometheus evaluates its rules and Alertmanager is
  not deployed, so nothing above reaches a human automatically yet. Until it does,
  `bash scripts/ops.sh health` on the VPS is the way these are noticed.
- **The backup and certificate rules are specified, not applied** — see
  [../decisions/backup-failure-signal.md](../decisions/backup-failure-signal.md)
  and [certificate-renewal.md](certificate-renewal.md).
- **Vault sealed and site down have no signal at all.** The response steps above
  are still correct; they just have to be triggered by a person or by
  `ops.sh health` rather than by an alert.

Every claim in that list was checked against Prometheus rather than inferred —
including which of the *existing* rules match no series at all — in
[../decisions/alert-series-verification.md](../decisions/alert-series-verification.md).
