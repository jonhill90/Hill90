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

## Deploy Vault

```bash
make deploy-vault
```

Expected outcome:
- `openbao` container starts on edge and internal networks.
- `vault.sh auto-unseal` runs automatically after compose up.
- Vault is initialized and unsealed (status: `sealed:false`).
- On VPS reboot, the `hill90-vault-unseal` systemd service auto-unseals within ~60 seconds.

See [Vault Unseal Runbook](./vault-unseal.md) for troubleshooting.

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
curl -f https://ai.hill90.com/mcp   # MCP gateway (AI service is internal-only)
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
docker compose -p hill90-prod-observability ps  # Monitoring
```

## Pre-Deploy Backups

Stateful service deploys (db, minio, auth, observability) automatically create a backup before the deploy cycle. Infrastructure deploys also backup traefik certificates and portainer data.

Backups are stored at `/opt/hill90/backups/<service>/<timestamp>/` on the VPS.

### Scheduled Backups

A daily cron job runs `backup-all` at 03:00 UTC. Weekly prune at 04:00 Sunday
removes backups older than 7 days. Logs at `/opt/hill90/backups/cron.log`.

Cron is configured by Ansible (`01-system-prep.yml`) during VPS bootstrap.
To verify on VPS: `crontab -l -u deploy | grep hill90`

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

## Rollback

The rollback script classifies changes and applies the appropriate strategy.

### Change Classes

| Class | Services | Strategy | Automated? |
|-------|----------|----------|------------|
| **code-only** | api, ai, mcp, ui | Checkout previous source, redeploy | Yes |
| **config-only** | auth, infra, observability | Checkout previous config, redeploy | Yes |
| **schema-forward** | db (when migrations change) | Restore from backup, then rollback code | Manual |
| **mixed** | any | Review, then rollback | Yes (with review) |

### Rollback Commands

```bash
# Classify changes before rolling back (read-only, safe)
bash scripts/rollback.sh classify api HEAD~1
make rollback-classify SERVICE=api REF=HEAD~1

# Automated rollback (code-only or config-only)
bash scripts/rollback.sh rollback api HEAD~1
make rollback SERVICE=api REF=HEAD~1

# After rollback, redeploy and verify
bash scripts/deploy.sh api prod
bash scripts/deploy.sh verify api
```

### Schema-Forward Rollback (Manual)

When the rollback script detects migration files, it refuses automated rollback and prints manual restore instructions:

1. Restore the database from the pre-deploy backup
2. Checkout the previous code
3. Redeploy both db and the app service
4. Verify health

### DB Migration Compatibility Policy

- All DB migrations must be backward-compatible with the previous application version
- Destructive schema changes (drop column, rename table) require two phases: deprecate first, remove in a subsequent release
- Pre-deploy backup is mandatory before any schema migration (enforced by deploy script)

### General Rollback Guidance

- If a service deploy fails, use `rollback.sh classify` to understand the change, then `rollback.sh rollback` or manual restore
- If infrastructure is unstable, rerun `make deploy-infra` before app redeploy
- For catastrophic failure, use the VPS rebuild flow in `docs/runbooks/vps-rebuild.md`

## Persistent Volume Safety Invariants

Stateful services (postgres, traefik, portainer, minio, observability) store data in Docker volumes. These invariants prevent data loss from volume namespace drift.

### Rules

1. **All compose volumes for stateful services must use explicit `name:` fields.** Without an explicit name, Docker Compose prepends the project name — if the project name changes, services silently mount new empty volumes while old data volumes remain disconnected.

2. **Never change compose project names or volume keys without a migration plan.** If a rename is unavoidable, pin volumes with `name:` first, verify mounts post-deploy, and document the migration.

### Banned Commands for Routine Operations

These commands destroy volume data and must never appear in deploy scripts or workflows:

- `docker compose down -v` — removes named volumes
- `docker volume rm` — deletes volumes directly
- `docker system prune` — may remove unused volumes

CI enforces this ban via the `Validate Repository` workflow (`ci.yml`).

### Pre-Change Backup

Before any compose file change that touches volumes or project names:

```bash
docker run --rm -v <volume>:/src -v /opt/hill90/backups:/backup alpine \
  tar czf /backup/<volume>.tar.gz -C /src .
```

### Post-Change Mount Verification

After deploying, confirm each container mounts the expected volume:

```bash
docker inspect <container> --format \
  '{{range .Mounts}}{{if eq .Destination "<path>"}}{{.Name}}{{end}}{{end}}'
```

Expected outputs:
- postgres (`/var/lib/postgresql/data`): `prod_postgres-data`
- traefik (`/letsencrypt`): `prod_traefik-certs`
- portainer (`/data`): `prod_portainer-data`

### Rollback

If a volume name change causes data loss:

1. Revert the `name:` field in the compose file
2. Redeploy the affected stack
3. If the original volume was deleted, restore from tar backup:
   ```bash
   docker volume create <volume-name>
   docker run --rm -v <volume-name>:/dest -v /opt/hill90/backups:/backup alpine \
     tar xzf /backup/<volume-name>.tar.gz -C /dest
   ```

## Chat Token Rotation

After rotating `CHAT_CALLBACK_TOKEN`, running agents must be restarted for the new token to take effect. The token is injected into each agentbox container at start time as an env var. Until an agent is stopped and restarted, it continues using the old token — callbacks from those agents will fail with 401.

**Rotation steps:**
1. Update the token in SOPS and vault (see secrets-workflow.md)
2. Redeploy API service: `bash scripts/deploy.sh api prod`
3. Restart all running agents: stop + start each agent via the UI or API

## Failure Modes

- Missing or invalid secrets: `sops`/runtime env errors at deploy time.
- Missing Docker networks: app deploy fails until `make deploy-infra` recreates them.
- ACME rate limiting: switch to staged testing cadence and retry after cooldown.
- Chat callback auth failure (401): `CHAT_CALLBACK_TOKEN` mismatch between API and agentbox — restart agents after token rotation.

## See Also

- [Deployment Architecture Reference](../../.github/docs/deployment.md) — compose files, workflows, and architecture details
- [Troubleshooting Guide](./troubleshooting.md) — common issues and fixes
