# Observability Runbook

Operational guide for the Hill90 LGTM (Loki, Grafana, Tempo, Prometheus) observability stack.

## Architecture

### Components

| Component | Role | Port | Signal |
|-----------|------|------|--------|
| **Prometheus** | Metrics collection and alerting | 9090 | Metrics |
| **Loki** | Log aggregation | 3100 | Logs |
| **Tempo** | Distributed tracing backend | 3200 (API), 4317 (gRPC), 4318 (HTTP) | Traces |
| **Grafana** | Dashboards and exploration UI | 3000 | All |
| **Promtail** | Log collector (Docker → Loki) | — | Logs |
| **Node Exporter** | Host-level metrics | 9100 | Metrics |
| **cAdvisor** | Container metrics | 8080 | Metrics |

### Signal Flow

```
Infrastructure
  ├── Host metrics ──────→ Node Exporter → Prometheus
  ├── Container metrics ─→ cAdvisor → Prometheus
  ├── Edge metrics ──────→ Traefik (:8082) → Prometheus
  ├── Logs ──────────────→ Promtail → Loki (Docker JSON logs)
  └── Traces ────────────→ Tempo (OTLP HTTP :4318 / gRPC :4317)

All signals ──→ Grafana (query + visualize)
```

### Signal Coverage by Service

| Service | Metrics | Logs | Traces |
|---------|---------|------|--------|
| Traefik | Prometheus (:8082) | Promtail | — |
| Node Exporter | Prometheus (:9100) | Promtail | — |
| cAdvisor | Prometheus (:8080) | Promtail | — |
| Grafana / Loki / Tempo | Prometheus (self-scrape) | Promtail | — |
| Portainer | — | Promtail | — |
| OpenBao | — | Promtail | — |

Tempo is deployed and receiving-capable, but nothing currently emits traces —
tracing was used by the shelved application. It is retained for future use.

## Deployment

### Deploy / Update

Canonical (VPS/CI):

```bash
bash scripts/deploy.sh observability prod
```

Local convenience:

```bash
make deploy-observability
```

Expected outcome: 7 containers healthy — `prometheus`, `grafana`, `loki`, `tempo`, `promtail`, `node-exporter`, `cadvisor`.

### Verification Checklist

After deployment, verify in order:

**1. Docker container health (binary liveness only):**

```bash
docker ps --filter name=prometheus --filter name=grafana --filter name=loki --filter name=tempo --filter name=promtail --filter name=node-exporter --filter name=cadvisor --format "table {{.Names}}\t{{.Status}}"
```

Or use `bash scripts/ops.sh health`.

> **Caveat**: The Docker healthcheck for `promtail` validates binary presence (`--version`), not endpoint readiness. A healthy Docker status does NOT guarantee the upstream connection is working.

**2. Prometheus targets (connection truth — required for exporters):**

```bash
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health, lastError: .lastError}'
```

This is the authoritative source for whether scrape targets are actually reachable. Always check this for `promtail`.

**3. Grafana datasource connectivity:**

Open Grafana at `https://grafana.hill90.com` (Tailscale-only) → Settings → Data Sources → test each connection.

**4. Alert rules loaded:**

```bash
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].name'
```

## Incident Triage Flow

When investigating an issue, follow this signal hierarchy:

1. **Grafana dashboards** — check for anomalies in metrics (Node Exporter, cAdvisor, service-specific)
2. **Loki logs** — search for error patterns around the incident timeframe
3. **Tempo traces** — find slow or failed request traces for the affected service
4. **Prometheus alerts** — check if any alerts fired before or during the incident

## Dashboards

| Dashboard | Source | Covers |
|-----------|--------|--------|
| Node Exporter | Provisioned | CPU, memory, disk, network (host) |
| cAdvisor | Provisioned | **Little — cAdvisor exposes no Docker containers on this host**, only cgroup and systemd slices. `Verified 2026-07-31` |
| Traefik | Provisioned | Request rates, latencies, errors |
| Loki Logs | Provisioned | Log search and exploration |

All dashboards are file-provisioned from `platform/observability/grafana/provisioning/dashboards/`.

## Alert Rules

> ## Alerts are delivered by email as of 2026-07-31 — this section used to say nobody received them.
>
> Alertmanager now runs on the platform and Prometheus is wired to it. The receiver is
> **email to the address in `ACME_EMAIL`**, via `smtp.hostinger.com:587` as
> `noreply@hill90.com` — the same server Keycloak already uses, with `SMTP_PASSWORD` from
> the encrypted store. No new account was created.
>
> **Delivery was proven end to end, not assumed**: a real probe failure fired
> `PublicSiteDown`, Prometheus sent it to Alertmanager, and Alertmanager delivered it via
> Hostinger — `alertmanager_notifications_total{integration="email"}` 1,
> `failed_total` 0. Two defects were found only by doing that, and neither was caught by
> `amtool check-config`: a 0600 config is unreadable by Alertmanager's `nobody` user, and
> the template function `default` does not exist in Alertmanager (use `or`).
>
> Reaching the UI: it is **not public and has no Traefik labels** — production Traefik sets
> no provider constraints, so a `Host` rule would put a silence-anything UI on the
> internet. Use `ssh vps -L 9093:localhost:9093`.
>
> Full history and the gaps still open: [alerting-audit.md](../decisions/alerting-audit.md).

Alerts live in `platform/observability/prometheus/alerts.yml`. Every rule carries
`summary`, `description` and **`action`** annotations; `action` is rendered into the email
as "Do this first" and is not optional — add it to any new rule.

| Alert | Condition | Severity | Notes |
|-------|-----------|----------|-------|
| **PublicSiteDown** | blackbox probe of `https://hill90.com/` not 200 for 2m | critical | **New.** The only signal for the product being down — the tenant's containers are not scrape targets |
| **VaultSealedOrUnreachable** | blackbox probe of OpenBao `/v1/sys/health` not 200 for 5m | critical | **New.** 503 means SEALED. Needs no token |
| ServiceDown | Any scrape target down > 5m | critical | Fired ≥48 h to 2026-07-26 with no receiver |
| HostMemoryHigh | **Host root cgroup** memory > 90% | warning | **Renamed from HighMemoryUsage** — it never watched containers, see below |
| DiskSpaceRunningLow | Root filesystem < 15% free | warning | Never fired; `/` is 87.6% free |
| PostgresConnectionsHigh | Active connections > 80% of max | warning | Never fired |
| LokiIngestionErrors | Ingestion error rate > 0 | warning | Never fired |
| TempoIngestionErrors | Ingestion failure rate > 0 | warning | Fired ~1.3 h with no receiver |
| **CertificateExpiringSoon** | any cert < 21 days remaining, 1h | warning | **New.** 21 days = nine consecutive failed renewals; thresholds argued in [certificate-renewal.md](certificate-renewal.md) |
| **CertificateExpiringCritical** | any cert < 10 days remaining, 1h | critical | **New.** ~20 failures; the warning was missed |
| **CertificateCountDropped** | fewer certs than 1h ago, 2h | warning | **New.** Catches a cert that vanished rather than aged. `for: 2h` so a Traefik restart does not double-report `ServiceDown` |
| **BackupNotSucceeding** | last success > 26h ago, 15m | warning | **New.** One missed night, fires ~05:00 |
| **BackupNotSucceedingCritical** | last success > 50h ago, 15m | critical | **New.** Two consecutive nights |
| **BackupSignalMissing** | metric absent, 6h | warning | **New.** The staleness rules are *silent* when the metric does not exist — this is the rule that notices the alarm was removed |

> **The backup metric comes from a textfile, and it does not exist until one full
> `backup-all` has run.** `backup.sh` writes
> `/opt/hill90/metrics/textfile_collector/hill90_backup.prom` at the end of a
> `backup-all`, and node-exporter serves it via
> `--collector.textfile.directory` through its existing `/rootfs` mount.
>
> **After deploying this, seed it rather than waiting**, or `BackupSignalMissing`
> fires six hours later and stays firing until 03:00:
>
> ```bash
> cd /opt/hill90/app && SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt \
>   bash scripts/backup.sh backup-all
> ```
>
> That is a real backup, not a stub — it takes about a minute.

> **`HostMemoryHigh` was called `HighMemoryUsage` and did not watch containers.**
> cAdvisor exposes 45 cgroup series and **zero Docker containers** —
> `count(container_memory_usage_bytes{name!=""})` is 0, and the only series with a memory
> limit is `id="/"`, whose limit is total host RAM. The rule therefore evaluates over the
> host root cgroup alone, and `{{ $labels.name }}` would render empty. The same absence is
> why the cAdvisor dashboard below shows no per-container data.

## Backup and Retention

| Component | Retention | Storage |
|-----------|-----------|---------|
| Prometheus | 7 days / 20 GB (whichever first) | `prometheus-data` volume |
| Loki | 7 days (compactor) | `loki-data` volume |
| Tempo | Default retention | `tempo-data` volume |
| Grafana | Persistent | `grafana-data` volume |

Volumes are backed up by `bash scripts/ops.sh backup` (Prometheus and Grafana volumes included).

## Known Caveats

- **Compose v2 `version` field warnings**: Cosmetic only, ignored by Docker Compose v2+.
- **Healthcheck binary-only checks**: `promtail --version` validates binary presence, not endpoint readiness. Docker reports healthy even if Loki is unreachable. Always cross-check Prometheus target status.
- **Tailscale-only access**: Grafana at `grafana.hill90.com` requires Tailscale VPN connection (IP whitelist middleware).
- **Promtail Docker socket**: Requires `/var/run/docker.sock` mount for container log discovery.
