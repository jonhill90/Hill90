# Deployment Reference

> **External users:** See [docs.hill90.com/getting-started/quickstart](https://docs.hill90.com/getting-started/quickstart) for the public deployment guide.

## Deployment Architecture

**Infrastructure and applications are deployed separately:**

1. **Infrastructure** (Traefik, dns-manager, Portainer) - Deploy once after VPS config
2. **Database** (PostgreSQL) - Deploy before application services
3. **Storage** (MinIO) - Deploy independently, before application services if needed
4. **Application services** (keycloak, api, ai, mcp, ui) - Deploy independently as needed

## Deployment Location

**Deployments must run on the VPS via SSH, not on the local Mac.**

The deploy scripts build and run Docker containers **wherever you execute them**, so SSH to the VPS first to ensure proper deployment.

## New Deployment Workflow

### After VPS Rebuild (3 Steps)

```bash
# Step 1: Rebuild VPS OS
make recreate-vps

# Step 2: Configure VPS (OS only - no containers)
make config-vps VPS_IP=<ip>

# Step 3a: Deploy infrastructure (Traefik, dns-manager, Portainer)
make deploy-infra

# Step 3b: Deploy all application services
make deploy-all
```

### Per-Service Deployment

Deploy individual services without affecting others:

```bash
make deploy-infra   # Traefik, dns-manager, Portainer
make deploy-db      # PostgreSQL database
make deploy-auth    # Keycloak identity provider
make deploy-api     # API service
make deploy-ai      # AI service
make deploy-mcp     # MCP service
make deploy-minio   # MinIO object storage
make deploy-all     # All app services (not infra or db)
```

## Docker Compose Files

Separate compose files in `deploy/compose/prod/`, grouped into stacks with explicit Docker Compose project names:

| Stack | Project Name | File | Services |
|-------|-------------|------|----------|
| edge | `hill90-prod-edge` | `docker-compose.infra.yml` | traefik, dns-manager, portainer |
| platform | `hill90-prod-platform` | `docker-compose.db.yml` | postgres, postgres-exporter |
| platform | `hill90-prod-platform` | `docker-compose.minio.yml` | minio |
| identity | `hill90-prod-identity` | `docker-compose.auth.yml` | keycloak |
| apps | `hill90-prod-apps` | `docker-compose.api.yml` | api |
| apps | `hill90-prod-apps` | `docker-compose.ai.yml` | ai |
| apps | `hill90-prod-apps` | `docker-compose.mcp.yml` | mcp |
| apps | `hill90-prod-apps` | `docker-compose.ui.yml` | ui |
| observability | `hill90-prod-observability` | `docker-compose.observability.yml` | full LGTM stack |

### Stack-Level Isolation

Each stack has a dedicated Docker Compose project name (`hill90-{env}-{stack}`). This prevents an errant `docker compose down` from affecting services in other stacks. For example, deploying the API cannot affect the database or edge proxy.

### Deploy Safety Policy

| Context | Docker Command | When Allowed |
|---------|---------------|--------------|
| Routine stateless deploy (api, ai, mcp, ui) | `up -d --force-recreate --no-deps` | Default |
| Routine stateful deploy (db, auth, minio, observability) | Stack-scoped `down` + `up -d` | Default |
| Edge stack deploy (traefik, dns, portainer) | `up -d --force-recreate` | Manual only via `workflow_dispatch` |
| Full platform teardown | Multiple stack-scoped `down` | Maintenance windows only |
| `--remove-orphans` | **NEVER** | Banned globally |

### Pre-Deploy Backups

Stateful service deploys automatically run `scripts/backup.sh` before the deploy cycle. Backups are stored at `/opt/hill90/backups/<service>/<timestamp>/` on the VPS with 7-day default retention.

| Service | Backup Method | Critical Volumes |
|---------|--------------|-----------------|
| db | `pg_dumpall` + volume tar | `postgres-data` |
| minio | Volume tar | `minio-data` |
| infra | Volume tar | `traefik-certs`, `portainer-data` |
| observability | Volume tar | `grafana-data`, `prometheus-data` |
| auth | Maps to `db` backup | (auth data lives in postgres) |

## GitHub Actions Deployment

### Orchestrator Workflow

A single `deploy.yml` orchestrator handles all push-triggered deploys with dependency ordering:

```
push to main → changes detection → deploy only affected services in dependency order
```

| Workflow | Role | Trigger |
|----------|------|---------|
| `deploy.yml` | Orchestrator | Push to `main` (path-filtered) or `workflow_dispatch` |
| `reusable-deploy-service.yml` | Reusable deploy job | Called by orchestrator |
| `deploy-infra.yml` | Edge stack (manual only) | `workflow_dispatch` only |
| `deploy-*.yml` (9 files) | Legacy per-service (dormant) | `workflow_dispatch` only |

### Dependency Graph

The orchestrator enforces deployment ordering:

- **Platform** (db, minio) — runs first, no dependencies
- **Identity** (auth) — waits for db
- **Apps** (api, mcp) — waits for auth; (ai, ui) — no dependencies
- **Observability** — no dependencies

### Path-Based Auto-Deployment

When you push changes to `main`:
- Changes to `platform/data/postgres/**` → Only database deploys
- Changes to `services/api/**` → Only API service deploys
- Changes to `services/ai/**` → Only AI service deploys
- Changes to `services/mcp/**` → Only MCP service deploys
- Changes to `services/ui/**` → Only UI service deploys
- Changes to `deploy/compose/prod/docker-compose.minio.yml` → Only MinIO deploys
- Changes to `platform/auth/keycloak/**` → Only Keycloak deploys

### Manual Deploy

Use `workflow_dispatch` on `deploy.yml` to deploy a specific service or all services:

```
gh workflow run deploy.yml -f service=api    # Deploy only API
gh workflow run deploy.yml -f service=all    # Deploy everything in order
```

## Let's Encrypt Configuration

**Certificate Rate Limits**

- `make deploy-*` uses **STAGING** certificates by default (`ACME_CA_SERVER` defaults to staging in compose)
- `make deploy-infra-production` uses **PRODUCTION** certificates (explicitly sets `ACME_CA_SERVER` to production URL)
- CI workflow `deploy-infra.yml` also sets production certificates automatically
- Rate limits (production): 5 failures/hour, 50 certs/week

## Architecture

### Services by Deployment Unit

**Infrastructure (deploy-infra):**
- **traefik** - Edge proxy (80/443)
- **dns-manager** - DNS-01 ACME challenges
- **portainer** - Container management (Tailscale-only)

**Auth (deploy-auth):**
- **keycloak** - Keycloak identity provider (auth.hill90.com)

**Database (deploy-db):**
- **postgres** - PostgreSQL database

**Storage (deploy-minio):**
- **minio** - S3-compatible object storage (console at storage.hill90.com, Tailscale-only)

**API (deploy-api):**
- **api** - API Gateway

**AI (deploy-ai):**
- **ai** - AI service

**MCP (deploy-mcp):**
- **mcp** - MCP Gateway

### Networks
- **hill90_edge** - Public-facing (traefik, api, ai, mcp, keycloak, ui)
- **hill90_internal** - Private services (postgres, minio, keycloak, all apps)

### Dependencies
- Deploy order: infra → db → minio → auth (Keycloak) → remaining app services

## Traefik Dashboard Authentication

The Traefik dashboard at `https://traefik.hill90.com` uses basic authentication.

**Credentials are automatically generated during deployment:**

1. Password hash stored in: `TRAEFIK_ADMIN_PASSWORD_HASH` (encrypted in secrets)
2. Deploy script generates: `platform/edge/dynamic/.htpasswd`

**Access credentials:**
- Username: `admin`
- Password: Stored in user's password manager (not in repo)

## File Locations

### Local (Your Machine)
- Repository: `/Users/jon/source/repos/Personal/Hill90`
- Age key: `~/.config/sops/age/keys.txt`
- SSH key: `~/.ssh/remote.hill90.com`

### VPS
- App directory: `/opt/hill90/app`
- Age key: `/opt/hill90/secrets/keys/keys.txt`
- Deploy user: `deploy`

## See Also

- [Deployment Runbook](../../docs/runbooks/deployment.md) — operational procedures and checklists
- [VPS Rebuild Runbook](../../docs/runbooks/vps-rebuild.md) — full VPS rebuild flow
- [Troubleshooting Guide](../../docs/runbooks/troubleshooting.md) — common issues and fixes
