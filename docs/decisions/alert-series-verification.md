# Do the alert rules match anything?

Every alert design this week assumed the observability stack was telling the
truth. This checks that assumption against Prometheus itself, for the specific
series each rule depends on.

**A rule matching no series never fires, and looks exactly like health.** That is
the same failure the whole alerting effort exists to prevent, one layer down.

`Verified 2026-07-31 09:33 UTC, read-only. Nothing was enabled, applied or restarted.`

## Result in one line

**Two of the six applied rules cannot do what their names say.** One is a
permanent no-op. One fires on the host while claiming to be about containers,
because **cAdvisor reports no containers at all** — and that turns out to be the
larger finding, with a precise cause.

---

## Method — why "no result" was never accepted as an answer

For a threshold rule an empty result is ambiguous. It means either *the condition
is false* (healthy, rule works) or *nothing matches* (rule is a permanent no-op),
and those are indistinguishable from the alert list. So every rule was probed
twice, as instant queries against `http://<prometheus>:9090/api/v1/query`:

| Probe | Empty result means |
|---|---|
| **Selector** — the bare series, threshold removed | the rule can **never** fire |
| **Expression** — the rule as written | not firing *today*, which is fine |

The selector is the one that matters. Prometheus reports `health=ok` for all six
applied rules and always has; a rule that matches nothing is, from its point of
view, perfectly healthy.

## The table

`match?` answers the question the rules were written for: would this rule ever
select anything.

### Applied rules — `platform/observability/prometheus/alerts.yml`

| Metric | Present | Label set observed | Rule matches? |
|---|---|---|---|
| `up` | **yes**, 10 series | `instance`, `job` | **yes** — but see coverage below |
| `container_memory_usage_bytes` | **yes**, 40 series | `id`, `instance`, `job` | **partly** — no container is among them |
| `container_spec_memory_limit_bytes` | yes, 34 series | `id`, `instance`, `job` | **1 series** has a limit > 0, and it is the host |
| `node_filesystem_avail_bytes{mountpoint="/"}` | **yes**, 1 | `device`, `fstype`, `instance`, `job`, `mountpoint` | **yes** — `/dev/sda4`, xfs, 174 GiB free |
| `pg_stat_activity_count` | **yes**, 48 | `datname`, `state`, `usename`, `server`, `instance`, `job`, … | **yes** |
| `pg_settings_max_connections` | **yes**, 1 | `instance`, `job`, `server` | **yes** — the join returns `0.06` |
| `loki_distributor_lines_received_total{status="error"}` | **NO** | metric has `aggregated_metric`, `instance`, `job`, `tenant` — **no `status`** | **NEVER** |
| `tempo_distributor_ingester_append_failures_total` | **yes**, 1 | `ingester`, `instance`, `job` | **yes** — and it is not quiet, see below |

### Specified but not applied — [#615 certificates](../runbooks/certificate-renewal.md), [#616 backups](backup-failure-signal.md)

| Metric | Present | Label set observed | Rule matches? |
|---|---|---|---|
| `traefik_tls_certs_not_after` | **yes**, 11 series | `cn`, `sans`, `serial`, `instance`, `job` | **yes** — ready to apply as written |
| `hill90_backup_last_success_timestamp_seconds` | **no** — emitter not built | — | n/a, by design |
| `absent(hill90_backup_...)` | returns `1` | — | **yes, immediately** — see ordering note |
| `node_scrape_collector_success{collector="textfile"}` | yes, `1` | `collector`, `instance`, `job` | confirms #616's claim |
| `node_textfile_scrape_error` | yes, `0` | `instance`, `job` | — |
| **anything for vault sealed** | **NO metric of any kind** | — | **there is no rule to write yet** |

---

## Finding 1 — `LokiIngestionErrors` has never been able to fire

```
loki_distributor_lines_received_total   ->  1 series
  {aggregated_metric="false", instance="loki:3100", job="loki", tenant="fake"} = 371995

loki_distributor_lines_received_total{status="error"}   ->  0 series
```

The metric carries no `status` label. The rule has been in place, evaluating
cleanly, reporting `health=ok`, matching nothing.

**And the label value is wrong too, independently.** A `status` label does exist
elsewhere in Loki's metrics — its values across `{job="loki"}` are `discarded`,
`matched`, `notfound`, `success`. **`error` is not one of them.** So even
corrected onto a metric that carries the label, `status="error"` would still
select nothing. Two independent reasons for the same silence.

Loki does expose real failure counters. Non-zero right now:

```
loki_ingester_wal_discarded_samples_total   630
loki_ingester_wal_discarded_bytes_total     128152
loki_rate_store_refresh_failures_total      1
```

`loki_discarded_samples_total` and `loki_write_failures_*` exist as names but
have **no series** — they are only created when the condition occurs, so a rule
on them needs the same `absent()` care as the backup signal. Choosing the
replacement is a design question, not a correction, so it is not made here.

## Finding 2 — cAdvisor sees no containers, and the cause is exact

This is the bigger one. `HighMemoryUsage` was already suspected of matching
nothing; the reason is worse than a label typo.

```
container_spec_memory_limit_bytes > 0   ->  1 series
  {id="/", instance="cadvisor:8080", job="cadvisor"} = 16761118720
```

That figure is **byte-identical to `node_memory_MemTotal_bytes`** and to
`machine_memory_bytes` (15.61 GiB) — checked rather than assumed. It is the root
cgroup: the whole machine, not a container.

Every `id` cAdvisor reports is a **systemd slice** — `/`, `/init.scope`,
`/system.slice/sshd.service`, `/user.slice/…`. Not one Docker container appears
among the 40. There is no `name` label; `{__name__=~"container_.*", name!=""}`
returns **0 series**, as does the `container_label_com_docker_compose_service`
form. cAdvisor's entire emitted label set contains no container identity at all.

So the rule reduces to **"host memory above 90% of 15.6 GiB"** wearing a
container alert's name, and it can never say which container — because it does
not know that containers exist. Currently `0.726`, so it can and would fire; it
would just be about the wrong thing and unable to name a culprit.

**The rule is not the careless part.** Nine services in
`deploy/compose/prod/` set `mem_limit` (64m to 2g), so the `limit > 0` guard was
written against a reality that should exist and would select nine containers if
cAdvisor could see them. That guard is also load-bearing today: without it the
33 limit-less series divide to `+Inf`, and `+Inf > 0.9` is true, so the rule
would fire permanently on phantom cgroups. It is the only reason this reads as
silence rather than as noise.

**Cause, from cAdvisor's own log** — 10,615 occurrences, one per container per
restart:

```
Failed to create existing container:
  /system.slice/docker-9408617b….scope: failed to identify the read-write layer ID
  - open /rootfs/var/lib/docker/image/overlayfs/layerdb/mounts/9408617b…/mount-id:
    no such file or directory
```

It *discovers* the container cgroups, then fails to instantiate them. The path it
wants belongs to Docker's classic graphdriver layout. This host runs
**Docker 29.5.3 with the containerd snapshotter** (`Driver: overlayfs`,
`driver-type io.containerd.snapshotter.v1`), where image metadata lives in
containerd and that directory does not exist:

```
/var/lib/docker/image/   ->   identity-cache.db          # and nothing else
/var/lib/docker/image/overlayfs/   absent
/var/lib/docker/image/overlay2/    absent
```

cAdvisor v0.52.1 has no path to the read-write layer under the snapshotter, gives
up on every container, and serves host cgroups only. Adding a mount will not fix
it — the directory it is looking for does not exist anywhere on this host.

**Nothing about this is visible from outside.** The container healthcheck
(`/healthz`) passes, `docker inspect` says `healthy`, `up{job="cadvisor"}` is
`1`, the scrape succeeds, and the rule evaluates without error. Every indicator
this estate has says the container-metrics pipeline is working. It has never
produced a single container metric.

**Consequence beyond one rule: there are no per-container resource metrics at
all.** No memory, CPU, network or disk figure for any of the 21 running
containers — platform or tenant. Any future rule of that shape starts from zero.

## Finding 3 — the vault alert has nothing to rest on

Not "the rule is wrong": there is no metric.

```
vault_core_unsealed / bao_core_unsealed / vault_sealed / openbao_core_unsealed   ->  all ABSENT
metric names containing "vault" or "bao", out of 2222 known   ->  none
scrape targets matching vault|bao   ->  0
```

OpenBao is not a scrape target. [alert-response.md](../runbooks/alert-response.md)
already says vault-sealed has no signal; this is the evidence, and it also says
what closing the gap requires — a scrape target and a token for
`/v1/sys/metrics`, not a rule.

The `systemctl status hill90-vault-unseal` step in the runbook remains the only
way to answer the question, which is why it is the runbook's first step.

## Finding 4 — the certificate rules are genuinely ready

The one design that survives contact intact. 11 series, values sane, and the
`cn` label the annotation interpolates (`{{ $labels.cn }}`) is present:

```
(traefik_tls_certs_not_after - time()) / 86400   ->  11 series
  cn="portainer.hill90.com"  42.76        cn="grafana.hill90.com"  42.76
  cn="vault.hill90.com"      84.91        cn="auth.hill90.com"     85.43
  cn="traefik.hill90.com"    85.69        cn="hill90.com"          87.76   (sans www)
  … 5 more
```

Consistent with the inventory in [certificate-renewal.md](../runbooks/certificate-renewal.md):
same 11 certificates, nearest expiry 42 days. Apply as written.

One property worth knowing rather than fixing: `serial` is a label, so **a
renewal replaces the series rather than updating it**. Harmless for the
threshold rules, and it is what makes `CertificateCountDropped`'s `offset 1h`
comparison meaningful — but any future rule using `changes()` or a long `for:`
on these series must expect identity churn at renewal.

## Finding 5 — two ordering hazards for whoever applies these

Neither is a defect. Both bite on the day the rules land.

**`BackupSignalMissing` fires immediately.** `absent(hill90_backup_last_success_timestamp_seconds)`
returns `1` today, correctly — the emitter is not built. Applied before
`backup.sh` writes the textfile, it goes off after its 6h `for:` and stays off.
The rule and the emitter must land together, or the rule lands second.

**`TempoIngestionErrors` is not quiet.** It reads inactive because the 5m rate is
`0` at this instant, but:

```
increase(tempo_distributor_ingester_append_failures_total[24h])   =  51
```

Trace appends are failing roughly fifty times a day, and have been. The rule is
correct and matching; it has simply had nowhere to deliver. **The first thing
Alertmanager does when it is wired up is surface a real problem nobody has looked
at yet** — that is a success, provided it is not mistaken for a misconfiguration
on day one.

## Finding 6 — what `up` actually covers

`ServiceDown` is `up == 0`, and it is sound. The question is its reach: **10
targets, all platform infrastructure.**

```
cadvisor  grafana  keycloak  loki  minio  node-exporter
postgres-exporter  prometheus  tempo  traefik
```

Not covered, verified by query rather than inference:

- **The tenant's seven containers.** `up{job=~".*app.*"}` → 0 series. `app-api`,
  `app-ui`, `app-ai`, `app-knowledge`, `app-mcp`, `app-litellm` and
  `app-docker-proxy` are scraped by nothing. All seven can be down with every
  alert quiet.
- **The public site.** `probe_success` → 0 series; no blackbox target exists.
  This is the point [alert-response.md](../runbooks/alert-response.md) makes at
  the top of its site-down section, now with evidence: `ServiceDown` means a
  scrape target stopped answering Prometheus, which is not the same as the site
  being down, and nothing measures the latter.
- **OpenBao**, per finding 3.

## What this changes

| | Before | After |
|---|---|---|
| `LokiIngestionErrors` | assumed working | **permanent no-op**, two independent reasons |
| `HighMemoryUsage` | suspected no-op | **host alert misnamed**; no container metrics exist estate-wide |
| Certificate rules | specified | **verified against live series; apply as written** |
| Backup rules | specified | **verified; must land with the emitter, not before** |
| Vault alert | "no signal" | **no metric and no scrape target**; needs a target, not a rule |
| `TempoIngestionErrors` | assumed quiet | **firing-worthy today**; expect it on day one |
| `ServiceDown` | assumed broad | **10 infra targets**; tenant and public site uncovered |

Nothing here is fixed, because three of the six are decisions rather than
corrections: which Loki metric replaces the no-op, whether to pursue container
metrics at all given the snapshotter incompatibility, and whether OpenBao gets a
scrape target. Those belong with the Alertmanager work in
[alerting-audit.md](alerting-audit.md).

## Reproducing this

The probes are instant queries; nothing persists. Prometheus publishes no host
port, so go in through the container:

```bash
docker exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=up' | head -c 400
docker exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/rules'
```

For any rule, query the **selector without its threshold** first. That is the
whole method, and it is the difference between "not firing" and "cannot fire".
