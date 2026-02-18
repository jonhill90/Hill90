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
| **postgres-exporter** | PostgreSQL metrics | 9187 | Metrics |

### Signal Flow

```
Application Services
  ├── Metrics ──→ Prometheus (scrape every 15s)
  ├── Logs ────→ Promtail → Loki (Docker JSON logs)
  └── Traces ──→ Tempo (OTLP HTTP :4318 / gRPC :4317)

Infrastructure
  ├── Host metrics ──→ Node Exporter → Prometheus
  ├── Container metrics ──→ cAdvisor → Prometheus
  └── PostgreSQL metrics ──→ postgres-exporter → Prometheus

All signals ──→ Grafana (query + visualize)
```

### Signal Coverage by Service

| Service | Metrics | Logs | Traces |
|---------|---------|------|--------|
| API (Node.js) | Prometheus scrape* | Promtail | OTEL auto-instrumentation |
| AI (Python) | Prometheus scrape* | Promtail | OTEL instrument CLI |
| MCP (Python) | Prometheus scrape* | Promtail | OTEL instrument CLI |
| Keycloak | Prometheus (:9000) | Promtail | Native KC_TRACING |
| PostgreSQL | postgres-exporter | Promtail | — |
| MinIO | Prometheus (/minio/v2/metrics/cluster) | Promtail | — |
| Traefik | Prometheus (:8082) | Promtail | — |
| UI (Next.js) | — | Promtail | — |
| dns-manager | — | Promtail | — |

*App services expose metrics if instrumented; current tracing config sets `OTEL_METRICS_EXPORTER=none`.

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

The `postgres-exporter` deploys with the database stack (`bash scripts/deploy.sh db prod`).

### Verification Checklist

After deployment, verify in order:

**1. Docker container health (binary liveness only):**

```bash
docker ps --filter name=prometheus --filter name=grafana --filter name=loki --filter name=tempo --filter name=promtail --filter name=node-exporter --filter name=cadvisor --format "table {{.Names}}\t{{.Status}}"
```

Or use `bash scripts/ops.sh health`.

> **Caveat**: Docker healthchecks for `promtail` and `postgres-exporter` validate binary presence (`--version`), not endpoint readiness. A healthy Docker status does NOT guarantee the upstream connection is working.

**2. Prometheus targets (connection truth — required for exporters):**

```bash
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health, lastError: .lastError}'
```

This is the authoritative source for whether scrape targets are actually reachable. Always check this for `postgres-exporter` and `promtail`.

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
| PostgreSQL | Grafana ID 9628 rev 7 | Connections, transactions, cache hits |
| MinIO | Grafana ID 13502 rev 2 | Bucket operations, storage usage |
| Keycloak | Grafana ID 19659 rev 1 | Login events, active sessions |
| Loki Logs | Provisioned | Log search and exploration |

All dashboards are file-provisioned from `platform/observability/grafana/provisioning/dashboards/`.

## Alert Rules

Baseline alerts in `platform/observability/prometheus/alerts.yml`:

| Alert | Condition | Severity |
|-------|-----------|----------|
| ServiceDown | Any scrape target down > 5m | critical |
| HighMemoryUsage | Container memory > 90% of limit | warning |
| DiskSpaceRunningLow | Root filesystem < 15% free | warning |
| PostgresConnectionsHigh | Active connections > 80% max | warning |
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
- **Healthcheck binary-only checks**: `promtail --version` and `postgres_exporter --version` validate binary presence, not endpoint readiness. Docker reports healthy even if upstream (Loki, PostgreSQL) is unreachable. Always cross-check Prometheus target status.
- **Tailscale-only access**: Grafana at `grafana.hill90.com` requires Tailscale VPN connection (IP whitelist middleware).
- **Promtail Docker socket**: Requires `/var/run/docker.sock` mount for container log discovery.
- **MinIO metrics auth**: Set to `public` (no bearer token required). Safe because MinIO is on `hill90_internal` network only.
