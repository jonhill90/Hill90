# Alerting audit — what would actually tell us something broke

`Verified 2026-07-31 08:44 UTC`, read-only against production.

> ## STATUS: the receiver was built. Read this as the audit that motivated it.
>
> Everything below describes the estate **before 2026-07-31 09:17 UTC**. Alertmanager now
> exists, Prometheus is wired to it, and email delivery is proven end to end. Two of the
> six ranked gaps — the public site and the sealed vault — are closed with new
> `PublicSiteDown` and `VaultSealedOrUnreachable` rules. **The remaining four are still
> open and are listed under "Follow-ups" at the end.** The diagnosis below is preserved
> deliberately: the reason each gap ranked where it did has not changed.

## The answer in one line (as of the audit)

**Nothing would tell us. There was no notification path out of this estate at all.**

Six Prometheus alert rules exist and evaluate correctly. Prometheus has **zero
Alertmanagers configured** — `/api/v1/alertmanagers` returns
`{"activeAlertmanagers":[],"droppedAlertmanagers":[]}` — and there is no Alertmanager
container. Grafana has **zero alert rules**. There is no MTA on the host and no `MAILTO`
in the crontab. `DEPLOY_WEBHOOK_URL`, which two workflows would post to, **is not
configured** as a repository secret, so that path silently no-ops too.

Every alerting component in this estate is present, plausible and inert.

**This is not hypothetical, and that is the finding.** `ServiceDown` **has fired in
production** — for `keycloak`, `minio` and `postgres-exporter`, continuously, for **at
least 48 hours**, ending 2026-07-26 06:42 UTC. Three critical-severity alerts, firing for
two days, delivered to nobody. The episode is only visible now because it happens to fall
inside the 7-day retention window; it began at or before the window's start, so its true
duration cannot be recovered.

## What exists

### Prometheus rules — `platform/observability/prometheus/alerts.yml`

All six load with `health=ok` and no evaluation errors. All are `inactive` right now.

| Rule | Ever fired? | Verdict |
|---|---|---|
| `ServiceDown` | **Yes** — ≥48 h, 3 targets, ended 2026-07-26 | Works. Delivered nowhere |
| `TempoIngestionErrors` | **Yes** — ~1.3 h cumulative | Works. Delivered nowhere |
| `DiskSpaceRunningLow` | Never | Untested. Signal exists and is healthy (87.6 % free on `/`) |
| `LokiIngestionErrors` | Never | Untested |
| `PostgresConnectionsHigh` | Never | Untested. Note its expression was already fixed once for a label-matching bug that made it unfireable |
| `HighMemoryUsage` | Never | **Broken — see below** |

### `HighMemoryUsage` cannot alert on any container

This is a third instance of the estate's favourite bug, found by checking rather than
reading.

cAdvisor exposes **45 cgroup series and not one Docker container**. Measured:
`count(container_memory_usage_bytes)` = 44, `count(container_memory_usage_bytes{name!=""})`
= **0**. The only ids mentioning Docker are `/system.slice/docker.service`,
`/system.slice/docker.socket` and `/system.slice/containerd.service` — the *daemons*, not
the containers. Everything else is `/`, `/init.scope` and systemd units.

`count(container_spec_memory_limit_bytes > 0)` = **1**, and that one series is `id="/"`
with a limit of 16,761,118,720 bytes — total host RAM.

So the rule evaluates over the host root cgroup and nothing else. It is a **host memory
alert wearing a container alert's name**, and its annotation
`"Container {{ $labels.name }} memory > 90%"` would render with an empty name if it ever
fired. The provisioned cAdvisor dashboard has the same problem for the same reason.

Root-causing cAdvisor's container visibility is a separate job; the audit finding is that
**no per-container memory, CPU or restart signal exists in Prometheus at all.**

### Grafana alerting — configured to deliver nowhere

Read from `grafana.db` read-only:

- `alert_rule` = **0**, `alert_instance` = **0**. Nothing has ever been defined or fired.
- `alert_configuration` = 1: the stock default, one receiver `grafana-default-email` of
  type `email`, and the default route pointing at it.
- No `GF_SMTP_*` environment variables are set on the container.

So Grafana's default contact point is an email receiver **with no SMTP server**. If
somebody created a Grafana alert rule today it would fire into a receiver that cannot
deliver, and the failure would be a line in Grafana's own log.

Grafana also logs, every start:
`can't read alerting provisioning files from directory path=/etc/grafana/provisioning/alerting`.
It is asking for the directory that would hold provisioned alert rules and contact points.

### Scrape coverage — 10 jobs, all `up`

`prometheus, traefik, keycloak, postgres-exporter, node-exporter, cadvisor, grafana, loki,
tempo, minio`.

**OpenBao is not scraped.** No `vault_core_unsealed` or equivalent series exists.
**The tenant's seven containers are not scraped** — no `app-ui`, `app-api` or the rest.
There is no blackbox probe, so nothing checks that `hill90.com` answers.

## What is not covered, ranked by how badly it would hurt

Jon's candidates, verified rather than accepted, plus two he did not list.

### 1. The public site could be down and nothing would notice — *not covered, no signal*

`hill90.com` is the tenant's UI and the actual product. None of the tenant's containers is
a scrape target and there is no HTTP probe anywhere, so `ServiceDown` structurally cannot
fire for them. Traefik's own metrics would show request rates changing, but no rule reads
them.

The tenancy contract says a tenant's problems are not automatically this repo's problems —
but "is the public hostname answering" is an edge question, and the edge is this repo's.
**Highest impact, no signal today.**

### 2. Vault sealed after a reboot — *not covered, no signal*

OpenBao is not a scrape target, so its seal state is invisible. A sealed vault does not
break user traffic, which is exactly why it would go unnoticed until the next deploy or —
worse — until a recovery. The auto-unseal path on boot is *already* listed as untested in
the 2026-07-31 handoff. Untested and unmonitored is the bad combination.

### 3. The nightly backup failing — *not covered, and this estate has already been bitten*

`backup-all` was deliberately made to exit non-zero on partial failure (#563). That exit
code goes to `>> /opt/hill90/backups/cron.log`. There is **no MTA on the host and no
`MAILTO`** in the crontab, so cron's own mail path is dead too. Nothing exports a
backup-freshness metric: node-exporter runs **without** `--collector.textfile.directory`
and has no textfile directory mounted, so the standard cheap path for this is not wired.

Three consecutive nightly backups already failed silently once. The fix made the script
fail loudly into a file nobody reads.

### 4. Certificate renewal failing silently — *signal exists, nothing watches it*

This is the one with the best cost-to-value ratio, because **the metric is already there**:
`traefik_tls_certs_not_after`, 11 certificates. Margins today:

| Certificate | Days remaining |
|---|---|
| `portainer.hill90.com`, `grafana.hill90.com` | **42.8** |
| `vault.hill90.com` | 84.9 |
| `auth.hill90.com` | 85.5 |
| `traefik.hill90.com` | 85.7 |
| `hill90.com`, `api`, `ai`, `litellm`, `storage`, `app-auth` | 87.8 |

All healthy. CLAUDE.md flags ACME failures as quiet, and the failure mode is a 30-day fuse
that ends with the public site untrusted for every visitor at once. **A rule over an
existing metric is all that is missing.**

### 5. A container in a restart loop — *not covered, no signal*

No container-level metrics exist (see `HighMemoryUsage` above), and Docker's own
`RestartCount` is not scraped. `ServiceDown` catches it only for the ten containers that
are scrape targets, and only after 5 minutes down — a container that restarts every 60
seconds may never be caught, because each scrape can land on a running instance.

### 6. Disk filling up — *signal exists, rule exists, delivery does not*

`DiskSpaceRunningLow` is correct and node-exporter reports `/` at **87.6 % free**. This one
needs nothing except a receiver. Slowest fuse of the six, and the only one where the
existing rule is genuinely fit for purpose.

## The cheapest meaningful addition

**A receiver is the whole problem.** Six rules, two of them proven to fire, and no
destination. Nothing else on this list is worth doing before that, because every other
improvement lands in the same void.

Two options, and they are complementary rather than alternatives.

### Option A — Alertmanager, with an email receiver (recommended first step)

One small container, an `alerting:` block in `prometheus.yml`, and a receiver.
**`SMTP_PASSWORD` already exists in the encrypted store** and Keycloak already sends through
`smtp.hostinger.com`, so no new account or credential is needed.

*Why this over Grafana-managed alerting:* the rules already exist in Prometheus and are
already (mostly) right. Grafana alerting would mean rewriting all six as Grafana rules, and
Grafana's provisioning directory for them does not exist yet. Alertmanager also brings
grouping, inhibition and silences, which matter — the 48-hour `ServiceDown` episode was
three simultaneous alerts that should arrive as one notification, not three.

*The honest caveat:* Alertmanager runs on the host it monitors. It cannot tell you the host
is gone, and it cannot tell you Prometheus stopped scraping. That is what Option B is for.

*Sequencing note, which the firing history earns:* nothing has fired in the five days since
2026-07-26, so wiring a receiver today would **not** produce a flood. But fix
`HighMemoryUsage` before or alongside it — shipping a receiver for a rule that fires with a
blank container name teaches you to ignore the channel.

### Option B — a dead-man's switch, outside the estate

Have the nightly backup cron ping an external service on success, and have that service
alert when the ping does not arrive. It is one line at the end of the cron entry.

This is the only mechanism proposed here that survives the estate being down, and it covers
three of the six gaps at once: **the backup failing, the host dying, and the "who watches
the watcher" hole in Option A.** For a homelab this may be worth more than Alertmanager,
and it is smaller.

### What to do first, if only one thing happens

**The certificate-expiry alert, delivered by whichever of the above lands first.** The
signal already exists, the failure is silent by nature, the blast radius is every visitor,
and the 30-day fuse means one notification is genuinely enough. Everything else on the
ranked list either needs a signal built first or has a fuse long enough to wait.

## Not verified

- Why cAdvisor sees no Docker containers. Established that it does not; not root-caused.
- Whether the 2026-07-24 to 07-26 `ServiceDown` episode was a real outage or three targets
  that did not exist yet — `minio` was deployed on 2026-07-31, so at least one was
  legitimately absent. This does not change the finding: the alert fired and reached nobody.
- Nothing here was changed on the host. No alerting component was deployed, configured or
  tested end to end, because no delivery path exists to test.


## Follow-ups — what this audit found and the first alerting change did NOT close

Ranked as before. Two of six are closed; these four are not.

1. **The nightly backup failing** (was #3). Still exits non-zero into a log file nobody
   reads. No MTA, no `MAILTO`, no freshness metric — node-exporter still runs without
   `--collector.textfile.directory`. **Cheapest fix:** have the backup cron write a
   `.prom` file with a completion timestamp and add a staleness rule. That is now worth
   doing, because a receiver exists to deliver it to.
2. **Certificate renewal failing silently** (was #4). The signal already exists —
   `traefik_tls_certs_not_after`, 11 certificates, soonest 42.8 days as of 2026-07-31.
   **This is now a three-line rule with a working receiver behind it** and is the obvious
   next change. It was left out of the first one only to keep that change to the two gaps
   with no signal at all.
3. **A container in a restart loop** (was #5). Still no signal: cAdvisor exposes no Docker
   containers on this host, which also makes `HostMemoryHigh` host-wide rather than
   per-container. Root-causing cAdvisor is the prerequisite.
4. **Nothing watches the watcher.** Alertmanager runs on the host it monitors, so it cannot
   report that host's death, and neither can Prometheus. The dead-man's-switch proposal —
   a ping from the backup cron to an external service that alerts when the ping stops —
   is unchanged and would close this and item 1 together.

Also unresolved from the audit body: **the tenant's seven containers are still not scrape
targets.** `PublicSiteDown` probes the public URL, which is the outcome that matters, but
it cannot say which component failed.
