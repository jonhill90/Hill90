# Deployment Reference

## Deployment Architecture

Three stacks, deployed independently:

1. **Edge** (Traefik, Portainer) — deploy first; it owns the Docker networks every other stack attaches to
2. **Vault** (OpenBao) — deploy and unseal before stacks that read secrets from vault
3. **Observability** (Prometheus, Grafana, Loki, Tempo + collectors) — no dependencies

> **Vault note:** `deploy.sh vault` automatically calls `vault.sh auto-unseal` after compose up. On VPS reboot, the `hill90-vault-unseal` systemd service auto-unseals within ~60 seconds.

## Deployment Location

**Deployments must run on the VPS via SSH, not on the local Mac.**

The deploy scripts build and run Docker containers **wherever you execute them**, so SSH to the VPS first to ensure proper deployment.

## Deployment Workflow

### After VPS Rebuild

```bash
# Step 1: Rebuild VPS OS
make recreate-vps

# Step 2: Configure VPS (OS only - no containers)
make config-vps VPS_IP=<ip>

# Step 3: Deploy the stacks (on the VPS)
bash scripts/deploy.sh infra prod
bash scripts/deploy.sh vault prod
bash scripts/deploy.sh observability prod
```

### Per-Stack Deployment

```bash
bash scripts/deploy.sh infra prod           # Traefik, Portainer
bash scripts/deploy.sh vault prod           # OpenBao
bash scripts/deploy.sh observability prod   # LGTM stack + collectors
bash scripts/deploy.sh verify <stack>       # post-deploy readiness check
```

Local convenience wrappers: `make deploy-infra`, `make deploy-vault`,
`make deploy-observability`.

## Docker Compose Files

Compose files live in `deploy/compose/prod/`, grouped into stacks with explicit
Docker Compose project names:

| Stack | Project Name | File | Services |
|-------|-------------|------|----------|
| edge | `hill90-prod-edge` | `docker-compose.infra.yml` | traefik, portainer |
| platform | `hill90-prod-platform` | `docker-compose.vault.yml` | openbao |
| observability | `hill90-prod-observability` | `docker-compose.observability.yml` | full LGTM stack + collectors |

### Stack-Level Isolation

Each stack has a dedicated Docker Compose project name (`hill90-{env}-{stack}`).
This prevents an errant `docker compose down` from affecting services in another
stack.

`docker-compose.infra.yml` is the sole creator of `hill90_edge`,
`hill90_internal` and `hill90_agent_internal`. The other stacks declare them
`external: true`, so the edge stack must be deployed first on a fresh host.

### Deploy Safety Policy

| Context | Docker Command | When Allowed |
|---------|---------------|--------------|
| Routine stateful deploy (vault, observability) | Stack-scoped `down` + `up -d` | Default |
| Edge stack deploy (traefik, portainer) | `up -d --force-recreate` | Manual only via `workflow_dispatch` |
| Full platform teardown | Multiple stack-scoped `down` | Maintenance windows only |
| `--remove-orphans` | **NEVER** | Banned globally, enforced by CI |

### Pre-Deploy Backups

Stateful deploys automatically run `scripts/backup.sh` before the deploy cycle.
Backups are stored at `/opt/hill90/backups/<service>/<timestamp>/` on the VPS
with 7-day default retention.

| Stack | Backup Method | Critical Volumes |
|-------|--------------|-----------------|
| infra | Volume tar | `prod_traefik-certs`, `prod_portainer-data` |
| vault | Volume tar | `openbao-data` |
| observability | Volume tar | `grafana-data`, `prometheus-data` |

## GitHub Actions Deployment

### Orchestrator Workflow

A single `deploy.yml` orchestrator handles push-triggered deploys:

```
push to main → change detection → deploy only affected stacks
```

| Workflow | Role | Trigger |
|----------|------|---------|
| `deploy.yml` | Orchestrator | Push to `main` (path-filtered) or `workflow_dispatch` |
| `reusable-deploy-service.yml` | Reusable deploy job | Called by orchestrator |
| `deploy-infra.yml` | Edge stack (manual only) | `workflow_dispatch` only |
| `deploy-vault.yml`, `deploy-observability.yml` | Single-stack manual deploy | `workflow_dispatch` only |

The edge stack is deliberately excluded from push-triggered deploys — recreating
Traefik re-requests certificates, and Let's Encrypt rate limits make that
something to do on purpose rather than on merge.

### Path-Based Auto-Deployment

When you push changes to `main`:

- Changes to `platform/observability/**` → observability deploys
- Changes to `deploy/compose/prod/docker-compose.observability.yml` → observability deploys
- Changes to `deploy/compose/prod/docker-compose.vault.yml` → vault deploys

### Manual Deploy

```bash
gh workflow run deploy.yml -f service=vault           # one stack
gh workflow run deploy.yml -f service=all             # everything in order
```

## Let's Encrypt Configuration

**Certificate Rate Limits**

- `make deploy-infra` uses whichever CA the **secrets store** holds in `ACME_CA_SERVER` (vault `secret/infra/traefik`, SOPS as fallback). There is no default anywhere: an unset value fails the deploy. Selecting staging renders, but warns loudly.
- `make deploy-infra-production` sets `ACME_REQUIRE_PRODUCTION=1`, which makes the render **refuse** if the configured CA is staging. It does not set `ACME_CA_SERVER` — the secrets store overrides a caller-set value, so exporting it would choose nothing.
- The `deploy-infra.yml` workflow also sets production certificates automatically
- Rate limits (production): 5 failures/hour, 50 certs/week

## Networks

- **hill90_edge** — ingress-facing; Traefik and the services it routes
- **hill90_internal** — `internal: true`, private service-to-service traffic
- **hill90_agent_internal** — `internal: true`, used by the hill90-app tenant (`app-api`, `app-ai`)

## Traefik Dashboard Authentication

The Traefik dashboard at `https://traefik.hill90.com` uses basic authentication
on top of the Tailscale IP allowlist.

**Credentials are automatically generated during deployment:**

1. Password hash stored in `TRAEFIK_ADMIN_PASSWORD_HASH` (encrypted in secrets)
2. Deploy script generates `platform/edge/dynamic/.htpasswd` (gitignored)

**Access credentials:**
- Username: `admin`
- Password: stored in the operator's password manager, not in the repo

## File Locations

### Local
- Age key: `~/.config/sops/age/keys.txt`
- SSH key: `~/.ssh/remote.hill90.com`

### VPS
- App directory: `/opt/hill90/app`
- Age key: `/opt/hill90/secrets/keys/keys.txt`
- Backups: `/opt/hill90/backups/`
- Deploy user: `deploy`

## See Also

- [Deployment Runbook](../../docs/runbooks/deployment.md) — operational procedures and checklists
- [VPS Rebuild Runbook](../../docs/runbooks/vps-rebuild.md) — full VPS rebuild flow
- [Troubleshooting Guide](../../docs/runbooks/troubleshooting.md) — common issues and fixes
