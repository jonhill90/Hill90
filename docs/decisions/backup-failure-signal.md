# Making a failed backup visible

**Status: specified, not built.** No signal exists today. This is the design and
the reasoning behind it; delivery belongs with the Alertmanager work in
[alerting-audit.md](alerting-audit.md).

`Established 2026-07-31, read-only against production.`

---

## The one design decision, and it is not the mechanism

**Alert on the absence of success, not on the presence of failure.**

Everything else here follows from that. A backup alert that fires when the job
runs and fails is worse than useless, because *the job running at all* is a
precondition it cannot check — and the likeliest real failures are the ones where
it never gets that far.

| Failure mode | Job runs? | Reaches its own error handler? | Emit-on-failure | Staleness of last success |
|---|---|---|---|---|
| One target fails (container absent) | yes | yes | **catches** | catches |
| Script dies mid-run — `set -e`, disk full | yes | **no** | misses | **catches** |
| Script hangs and never returns | partly | no | misses | **catches** |
| `crond` not running, crontab lost | **no** | — | misses | **catches** |
| Host down at 03:00 | **no** | — | misses | **catches** |
| Backup "succeeds" writing nothing | yes | yes | depends | catches, if success is recorded only after verification |

Emit-on-failure catches exactly one row — and it is the row that is *already*
the most survivable, because the script handles it deliberately and continues.
The dead-man's switch catches all six.

**The corollary that makes it work: the success timestamp must be written only on
full success.** If the job writes it at the end of every run regardless of
outcome, staleness never triggers and the entire design collapses into nothing.
That is the single line most likely to be got wrong by someone implementing this
in a hurry.

## Why there is no signal at all today

The backup is a **host cron job**, not a container:

```
0 3 * * *  cd /opt/hill90/app && bash scripts/backup.sh backup-all >> /opt/hill90/backups/cron.log 2>&1
0 4 * * 0  cd /opt/hill90/app && bash scripts/backup.sh prune 7   >> /opt/hill90/backups/cron.log 2>&1
```

Three separate reasons nothing can see it:

1. **Promtail scrapes Docker only** — `docker_sd_configs` against the socket. A
   host file is outside its view entirely, so `cron.log` reaches neither Loki nor
   Grafana.
2. **The exit code goes nowhere.** `cmd_backup_all` is careful — it runs all six
   targets even if one fails, collects the failures and *deliberately* exits
   non-zero so a partial backup is never reported as success. Cron then discards
   that exit code: no `MAILTO`, and **no `sendmail` on the host**.
3. **Prometheus cannot see a cron job.** There is no target to scrape.

So the estate's most careful failure handling terminates in a log file nobody
reads. That is why the app-db regression was caught by someone happening to look.

## The signal: a textfile the job writes, node-exporter serves

**The textfile collector is already enabled** — verified rather than assumed:

```
node_scrape_collector_success{collector="textfile"} 1
node_textfile_scrape_error 0
```

What is missing is only the **directory** for it to read.
`--collector.textfile.directory` is unset, so it reads nothing. And node-exporter
already mounts `/:/rootfs:ro`, so **no new mount is needed** — one flag, and a
node-exporter restart.

That restart is worth naming explicitly because it is the opposite of the edge:
node-exporter serves no traffic, sits in no request path, and its restart costs a
gap in metrics measured in seconds.

### The metrics

Written by `backup.sh` at the end of a run, to
`/var/lib/node_exporter/textfile_collector/hill90_backup.prom`:

```
# HELP hill90_backup_last_success_timestamp_seconds Unix time of the last fully successful backup-all
# TYPE hill90_backup_last_success_timestamp_seconds gauge
hill90_backup_last_success_timestamp_seconds 1793073600

# HELP hill90_backup_last_run_timestamp_seconds Unix time of the last attempt, successful or not
hill90_backup_last_run_timestamp_seconds 1793073600

# HELP hill90_backup_target_success 1 if this target produced a usable backup on the last run
hill90_backup_target_success{target="db"} 1
hill90_backup_target_success{target="app-db"} 1
hill90_backup_target_success{target="minio"} 1
hill90_backup_target_success{target="vault"} 1
hill90_backup_target_success{target="infra"} 1
hill90_backup_target_success{target="observability"} 1

# HELP hill90_backup_duration_seconds Wall-clock duration of the last run
hill90_backup_duration_seconds 63
```

**`last_success` is the trigger. Everything else is annotation** — it exists so
the person woken by the alert knows which target broke without reading a 28,000
byte log. Keying the alert on the per-target gauges instead would reintroduce
exactly the emit-on-failure weakness: those gauges are only written when the job
runs.

Two implementation notes that are not optional:

- **Write atomically** — to `hill90_backup.prom.tmp`, then `mv`. node-exporter
  reads the directory on every scrape and a half-written file makes
  `node_textfile_scrape_error` flip to 1, which is a real alertable condition and
  should not be caused by us.
- **Do not let the file be tidied away.** It lives under `/var/lib`, not `/tmp`,
  precisely so `systemd-tmpfiles-clean` never touches it — that timer is active
  on this host.

## The threshold

The job runs at **03:00 UTC daily** and takes about a minute — last night's run
wrote its artifacts at `03:00:38` and finished by `03:01`. So in a healthy estate
the gap between successes is 24 hours plus a few seconds.

| Threshold | Fires at | Verdict |
|---|---|---|
| 24h | ~03:01 | **No.** Zero grace. Any slow night pages someone |
| **26h** | **~05:00** | **Warning.** One missed night, with two hours of slack. Fires in the morning rather than the small hours |
| **50h** | ~05:00 next day | **Critical.** Two consecutive nights. The warning was missed and the backup set is genuinely ageing |
| 7 days | — | **No.** Six nights of silent non-backup before anyone hears |

```yaml
# platform/observability/prometheus/alerts.yml — NOT yet applied
- alert: BackupNotSucceeding
  expr: (time() - hill90_backup_last_success_timestamp_seconds) / 3600 > 26
  for: 15m
  labels:
    severity: warning

- alert: BackupNotSucceedingCritical
  expr: (time() - hill90_backup_last_success_timestamp_seconds) / 3600 > 50
  for: 15m
  labels:
    severity: critical

# The watcher-watching case: the mechanism itself gone, rather than stale.
- alert: BackupSignalMissing
  expr: absent(hill90_backup_last_success_timestamp_seconds)
  for: 6h
  labels:
    severity: warning
```

`BackupSignalMissing` matters because of how the primary rule fails: if the
textfile is deleted, or was never written, `time() - <absent>` produces **no
result at all** and `BackupNotSucceeding` can never fire. A staleness alert is
silent about a metric that does not exist. It will overlap with `ServiceDown`
when node-exporter is the cause; that is acceptable duplication for a rule whose
job is to notice that the alarm was removed.

## What the alert should say at 3am

The reader may not remember how backups work here. The annotation should carry
its own context:

> **`BackupNotSucceeding` — no fully successful backup for {{ $value }} hours.**
>
> Backups run nightly at **03:00 UTC** from `deploy`'s crontab on the VPS, and
> write to `/opt/hill90/backups/<target>/<timestamp>/`. This alert means the last
> run either did not happen or did not finish cleanly.
>
> **This is not data loss, and it is probably not urgent tonight.** Previous
> nights' backups are still on disk and still restorable. If this is the first
> night, it can wait until morning. If `BackupNotSucceedingCritical` is also
> firing, two nights have now failed and it should not wait again.
>
> **Start here:**
> 1. Did it run at all? `sudo tail -40 /opt/hill90/backups/cron.log`
>    — no entry for last night means cron did not fire, not that the backup broke.
> 2. Which target failed? `hill90_backup_target_success` in Prometheus, or the
>    `Backup FAILED for:` lines in that log.
> 3. A target whose container is legitimately absent is a **known** case — the
>    script continues and fails the run at the end on purpose, so one missing
>    tenant does not cost the other five their backups.
> 4. Re-run by hand when the cause is fixed:
>    `cd /opt/hill90/app && bash scripts/backup.sh backup-all`
>
> Runbook: `docs/runbooks/disaster-recovery.md`

The second paragraph is the part that earns its place. An alert that does not say
whether to get out of bed gets treated as though it always means yes, until it is
treated as though it always means no.

## What this does not cover

- **Backups that succeed but cannot be restored.** The signal proves a run
  completed, not that the artifact is usable. Restore rehearsal is a separate
  concern and the consistency caveats are already recorded against `backup.sh`.
- **Off-host copies.** Everything is on the same VPS; losing the host loses the
  backups with it. That is a bigger decision than this alert.
- **`cron.log` grows forever.** It is `>>` with no rotation — 28KB now, and the
  triage step above tells people to read it. Small, adjacent, worth a separate fix.

## Scope

Nothing was built, enabled, deployed or restarted. `backup.sh` was read, not
modified. The metric names, the flag and the rules above are specified for
whoever implements them — and the rules should land with whichever receiver the
alerting work settles on, because a rule with no receiver is the same silence in
a different file.
