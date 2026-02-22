# Deployment Runbook

Standard deployment process for Hill90 on the Hostinger VPS.

## Prerequisites

- Access to the VPS over Tailscale (`remote.hill90.com` or `<tailscale-ip>`).
- Age key present on VPS at `/opt/hill90/secrets/keys/keys.txt`.
- Encrypted secrets file available in repo (`infra/secrets/prod.enc.env`).

## Deploy Infrastructure

```bash
make deploy-infra
```

Expected outcome:
- `traefik`, `dns-manager`, and `portainer` containers are healthy.
- `hill90_edge` and `hill90_internal` Docker networks exist.
- DNS-01 certificate flow is functional for Tailscale-only routes.

## Deploy Database

```bash
make deploy-db
```

Expected outcome:
- `postgres` container is healthy on the internal network.
- Required before `make deploy-all` (Keycloak depends on PostgreSQL).

## Deploy Storage (Optional)

```bash
make deploy-minio
```

Expected outcome:
- `minio` container is healthy on edge and internal networks.
- S3 API available at `http://minio:9000` from internal containers.
- Console at `https://storage.hill90.com` (Tailscale-only).

## Deploy Observability

```bash
bash scripts/deploy.sh observability prod   # canonical (VPS/CI)
make deploy-observability                    # convenience (local Mac)
```

Expected outcome:
- 7 containers healthy: `prometheus`, `grafana`, `loki`, `tempo`, `promtail`, `node-exporter`, `cadvisor`.
- Grafana accessible at `https://grafana.hill90.com` (Tailscale-only).
- Prometheus scrape targets all show `up`.

## Deploy Application Services

```bash
make deploy-all
```

Expected outcome:
- `keycloak`, `api`, `ai`, `mcp`, `ui` are running.
- Public routes respond through Traefik with valid certificates.

## Validate Deployment

```bash
make health
make dns-verify
```

Optional targeted checks:

```bash
make logs-traefik
curl -f https://api.hill90.com/health
curl -f https://ai.hill90.com/health
curl -f https://auth.hill90.com/realms/hill90/.well-known/openid-configuration

# MinIO console (Tailscale-only):
curl -f https://storage.hill90.com
```

## SSH-Based Deployment (On VPS)

```bash
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh infra prod && bash scripts/deploy.sh db prod && bash scripts/deploy.sh minio prod && bash scripts/deploy.sh observability prod && bash scripts/deploy.sh all prod'
```

## Stack-Level Project Isolation

All Docker Compose operations use explicit project names to prevent cross-stack interference:

| Stack | Project Name | Services |
|-------|-------------|----------|
| edge | `hill90-prod-edge` | traefik, dns-manager, portainer |
| platform | `hill90-prod-platform` | postgres, minio |
| identity | `hill90-prod-identity` | keycloak |
| apps | `hill90-prod-apps` | api, ai, mcp, ui |
| agentbox | `hill90-prod-agentbox` | agentbox-* |
| observability | `hill90-prod-observability` | prometheus, grafana, loki, tempo, promtail, node-exporter, cadvisor |

### Operational Invariants

1. **No `--remove-orphans`** — banned globally in all scripts and workflows.
2. **All `docker compose` calls use explicit `-p <project>`** — no implicit project names.
3. **Stateless apps use `up -d --force-recreate --no-deps`** — no `down` step, zero-downtime replacement.
4. **Edge deploy is manual-only** — never auto-triggered by push.
5. **No local VPS file edits** — all changes go through git + CI.

### Inspecting Stacks

```bash
docker compose -p hill90-prod-edge ps          # Edge services
docker compose -p hill90-prod-platform ps       # Database + storage
docker compose -p hill90-prod-identity ps       # Auth
docker compose -p hill90-prod-apps ps           # App services
docker compose -p hill90-prod-agentbox ps       # Agent containers
docker compose -p hill90-prod-observability ps  # Monitoring
```

## Pre-Deploy Backups

Stateful service deploys (db, minio, auth, observability) automatically create a backup before the deploy cycle. Infrastructure deploys also backup traefik certificates and portainer data.

Backups are stored at `/opt/hill90/backups/<service>/<timestamp>/` on the VPS.

### Manual Backup Commands

```bash
# Backup all critical volumes
make backup                    # or: bash scripts/backup.sh backup-all

# Backup a specific service
make backup-db                 # or: bash scripts/backup.sh backup db
make backup-minio              # or: bash scripts/backup.sh backup minio
make backup-infra              # or: bash scripts/backup.sh backup infra
make backup-observability      # or: bash scripts/backup.sh backup observability

# List available backups
make backup-list               # or: bash scripts/backup.sh list
bash scripts/backup.sh list db # List only db backups

# Prune old backups (default: 7-day retention)
make backup-prune              # or: bash scripts/backup.sh prune
bash scripts/backup.sh prune 14 # Keep 14 days instead

# Restore from backup
make backup-restore SERVICE=db BACKUP_PATH=/opt/hill90/backups/db/20260222_120000
```

### What Gets Backed Up

| Service | Backup Method | Files |
|---------|--------------|-------|
| db | `pg_dumpall` + volume tar | `database.sql`, `postgres-data.tar.gz` |
| minio | Volume tar | `minio-data.tar.gz` |
| infra | Volume tar | `traefik-certs.tar.gz`, `portainer-data.tar.gz` |
| observability | Volume tar | `grafana-data.tar.gz`, `prometheus-data.tar.gz` |

### Restore Procedure

1. Stop the target service: `make down-<service>`
2. Restore: `make backup-restore SERVICE=<service> BACKUP_PATH=<path>`
3. Restart: `docker restart <container>`
4. Verify: `bash scripts/deploy.sh verify <service>`

For PostgreSQL, prefer the SQL dump restore (`database.sql`) over volume tar — it's portable and handles version differences.

## Rollback Guidance

- If a service deploy fails, redeploy the last known good compose revision and rerun `make health`.
- If infrastructure is unstable, rerun `make deploy-infra` before app redeploy.
- For catastrophic failure, use the VPS rebuild flow in `docs/runbooks/vps-rebuild.md`.

## Failure Modes

- Missing or invalid secrets: `sops`/runtime env errors at deploy time.
- Missing Docker networks: app deploy fails until `make deploy-infra` recreates them.
- ACME rate limiting: switch to staged testing cadence and retry after cooldown.

## See Also

- [Deployment Architecture Reference](../../.github/docs/deployment.md) — compose files, workflows, and architecture details
- [Troubleshooting Guide](./troubleshooting.md) — common issues and fixes
