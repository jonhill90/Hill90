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
| cAdvisor | Provisioned | Container CPU, memory, network |
| Traefik | Provisioned | Request rates, latencies, errors |
| Loki Logs | Provisioned | Log search and exploration |

All dashboards are file-provisioned from `platform/observability/grafana/provisioning/dashboards/`.

## Alert Rules

Baseline alerts in `platform/observability/prometheus/alerts.yml`:

| Alert | Condition | Severity |
|-------|-----------|----------|
| ServiceDown | Any scrape target down > 5m | critical |
| HighMemoryUsage | Container memory > 90% of limit | warning |
| DiskSpaceRunningLow | Root filesystem < 15% free | warning |
| LokiIngestionErrors | Ingestion error rate > 0 | warning |
| TempoIngestionErrors | Ingestion failure rate > 0 | warning |

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
