# Disk: what consumes it, what is bounded, and when it matters

**Answer first: note it, do not act.** The disk is **13% full** with 173 GiB free.
Nothing is close to anything.

Two things are genuinely unbounded — the Docker build cache and container logs —
and both are cheap to bound. Neither is urgent, and the reason is quantified
below rather than asserted.

`Measured 2026-07-31 ~10:15 UTC, read-only. Nothing was pruned, deleted or changed.`

---

## Current state

```
/dev/sda4  xfs  198.74 GiB total   25.53 GiB used   173.21 GiB free   13% used
```

`DiskSpaceRunningLow` fires below 15% free — that is **29.8 GiB free**. The host
is **143 GiB above the threshold**.

## Where the 25.5 GiB is

| Location | Size | What |
|---|---|---|
| `/var/lib/containerd` | **19 GiB** | image data — `overlayfs` snapshotter 15 GiB, content store 3.4 GiB |
| `/var/lib/docker/rootfs` | 6.2 GiB | container writable layers |
| `/opt/hill90/backups` | **3.7 GiB** | of which `observability` alone is 3.5 GiB |
| `/var/lib/docker/volumes` | 1.1 GiB | every named volume, all services |
| `/var/lib/docker/buildkit` | 68 MiB | — |
| `/var/lib/docker/containers` | 8.2 MiB | json logs |

Image data lives under `containerd`, not `docker`, because this host runs the
containerd snapshotter — the same fact that blinds cAdvisor
([alert-series-verification.md](alert-series-verification.md)). `du` totals
exceed `df` used because layers are shared; treat them as attribution, not
addition.

### Volumes in full — including the two held deliberately

| Volume | Size |
|---|---|
| `prometheus-data` | 697 MiB |
| `prod_postgres-data` | 103 MiB |
| **`prod_app-postgres-data`** | **103 MiB** ← retained on purpose |
| `loki-data` | 61 MiB |
| `tempo-data` | 39 MiB |
| `grafana-data` | 31 MiB |
| `prod_minio-data` | 316 KiB |
| **`prod_app-minio-data`** | **168 KiB** ← retained on purpose |
| `openbao-data` | 180 KiB |
| `prod_traefik-certs` | 148 KiB |

**The two volumes being held cost 103 MiB between them — 0.05% of the disk.**
Whether to keep them is not a capacity question and should not be argued as one.
They are also static: both services are stopped, so neither grows.

## Bounded, and verified bounded

| Store | Bound | Configured? | Now | Headroom |
|---|---|---|---|---|
| Prometheus TSDB | `--storage.tsdb.retention.time=7d` **and** `retention.size=20GB` | **yes, both** | 697 MiB | 3.4% of its own cap |
| Loki chunks | `retention_period: 168h` **and** `compactor.retention_enabled: true` | **yes, both** | 61 MiB | rolling 7 days |
| Backups | `prune 7` — deletes older than 7 **days** — Sunday 04:00 | yes | 3.7 GiB | rolling 7 days |

Two of these deserve a note, because each has a way of being configured and still
doing nothing:

- **Loki's `retention_period` is inert without `compactor.retention_enabled`.**
  Both are present here. A config carrying only the first would look configured
  and delete nothing.
- **`prune 7` is days, not snapshots.** Verified against reality rather than read
  from the script: `db` and `minio` still hold snapshots from 2026-07-20, which
  is correct — prune last ran Sunday 2026-07-26 with a 7-day cutoff, so anything
  after 07-19 survives. Consistent, so prune is working.

## Unbounded

**1. Docker build cache — the largest single unbounded store.**

```
Build cache   9.264 GB total   6.996 GB reclaimable   142 entries   0 active
oldest entry: 6 weeks
```

Nothing prunes it. The `deploy` crontab contains exactly two entries — the
nightly backup and the weekly *backup* prune — and there is no `docker system
prune` anywhere on the host.

**2. Container logs — no rotation of any kind.**

`/etc/docker/` is **empty**: there is no `daemon.json`. And **zero** compose
files under `deploy/compose/prod/` contain a `logging:` block. So every container
uses the default `json-file` driver with no `max-size` and no `max-file`.

Currently this is only 8.2 MiB — and that figure is misleading. **A container's
log is destroyed when the container is recreated**, and these were recreated at
09:45 today. Frequent deploys have been masking an unbounded setting by accident.
A long-lived container that logs steadily has nothing stopping it.

**3. `cron.log`** — appended with `>>`, never rotated. 28 KiB, already recorded
in [backup-failure-signal.md](backup-failure-signal.md).

## Growth, and why the obvious projection is wrong

Measured from Prometheus over its full retained window:

| Window | Change in free space |
|---|---|
| 1 h | −0.687 GiB |
| 6 h | −1.250 GiB |
| 24 h | −1.863 GiB |
| 2 d | −4.050 GiB |
| **7 d** | **−7.399 GiB** |

`deriv` over 7 days gives **−1.11 GiB/day**, monotonic — free space over the
window ran from 189.89 GiB down to 173.21 GiB and never recovered. Extrapolated
naively:

> **129 days to the 15% alert threshold, 156 days to full.**

**Do not use that number as a forecast.** It is measured from an atypical week,
and the data says so:

- days −7 to −2 consumed **0.67 GiB/day**; the last two days consumed
  **2.03 GiB/day** — three times the rate. The trend is *accelerating*, which a
  storage-driven trend would not do.
- **`observability` backups today: five snapshots, ~290 MiB each, 1.38 GiB
  total.** Only one of those (03:00) is the nightly. The other four are
  **pre-deploy** backups. Against 1.86 GiB consumed in 24 hours, deploy-triggered
  backups alone account for roughly **three quarters of the day's consumption**.
- the −0.687 GiB in the last hour coincides with the 09:45 observability deploy.

So consumption here is **proportional to deploy activity, not to time**. This
week held the storage cutover, the retirement of `app-postgres` and
`app-keycloak`, and the Alertmanager build. In a quiet week every large store is
bounded and net growth approaches zero.

### The honest limit on any longer forecast

**Prometheus retains 7 days.** There is no 30- or 90-day history on this host to
extrapolate from, and none can be recovered — Prometheus does not backfill. Any
monthly or annual figure would be a busy week multiplied by 52, which is not an
estimate but an arithmetic operation on the wrong input.

What can be said without guessing: **8.95 GiB is reclaimable right now**
(build cache 6.996 + images 1.844 + volumes 0.108). That is **more than the
entire 7.40 GiB the busiest week on record consumed.** A single
`docker system prune` today would return more space than this week took.

That is the argument for "note it": the unbounded stores grow slowly relative to
143 GiB of headroom, and the remedy is one command whose effect exceeds a year of
plausible growth.

## What this says about the existing advice

[alert-response.md](../runbooks/alert-response.md) tells the reader **not** to
prune backups to free space. The numbers support it and sharpen it: backups are
**3.7 GiB of 25.5 GiB used — 1.9% of the disk**. Pruning every backup on the host
would move the needle by under two percent while destroying the recovery position
at the moment it is most likely to be needed. If disk ever is the emergency, the
build cache is 2.5× the size of every backup combined and costs nothing to lose.

## Recommended, in priority order — none urgent

1. **Bound container logs.** A `daemon.json` with `log-driver: json-file` and
   `max-size: 10m`, `max-file: 3` caps every container at 30 MiB. This is the
   only item where the current small number is an artifact rather than a measure.
   Requires a Docker daemon restart, so it belongs with other host work rather
   than on its own.
2. **Schedule a build-cache prune.** `docker builder prune -f --filter until=168h`
   weekly would hold ~7 GiB. Deliberately narrower than `docker system prune -a`,
   which would also remove images that are merely not running and force re-pulls.
3. **Rotate `cron.log`**, already noted elsewhere and still trivial.

## What was not done

Nothing was pruned, deleted, rotated or configured. Every figure above is a read:
`df`, `du`, `docker system df`, container config inspection, and instant queries
against Prometheus. The retained volumes were measured, not touched.
