# Deployment Reference

## Deployment Architecture

**Infrastructure and applications are deployed separately:**

1. **Infrastructure** (Traefik, dns-manager, Portainer) - Deploy once after VPS config
2. **Database** (PostgreSQL) - Deploy before application services
3. **Application services** (keycloak, api, ai, mcp, ui) - Deploy independently as needed

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
make deploy-all     # All app services (not infra or db)
```

### Deprecated Aliases

The following commands are deprecated aliases and should not be used for new workflows:

```bash
make deploy              # DEPRECATED - use make deploy-infra + make deploy-all
make deploy-production   # DEPRECATED - use make deploy-infra + make deploy-all
```

## Docker Compose Files

Separate compose files in `deploy/compose/prod/`:

| File | Services | Networks |
|------|----------|----------|
| `docker-compose.infra.yml` | traefik, dns-manager, portainer | Creates hill90_edge, hill90_internal |
| `docker-compose.auth.yml` | keycloak | Uses external networks |
| `docker-compose.db.yml` | postgres | Uses external networks |
| `docker-compose.api.yml` | api | Uses external networks |
| `docker-compose.ai.yml` | ai | Uses external networks |
| `docker-compose.mcp.yml` | mcp | Uses external networks |
| `docker-compose.ui.yml` | ui | Uses external networks |
| `docker-compose.yml` | All services (legacy) | Creates networks |

## GitHub Actions Deployment

### Per-Service Workflows

| Workflow | Trigger | Services |
|----------|---------|----------|
| `deploy-infra.yml` | Manual only | traefik, dns-manager, portainer |
| `deploy-auth.yml` | `platform/auth/keycloak/**` changes | keycloak |
| `deploy-db.yml` | `docker-compose.db.yml`, `platform/data/postgres/**` | postgres |
| `deploy-api.yml` | `src/services/api/**` changes | api |
| `deploy-ai.yml` | `src/services/ai/**` changes | ai |
| `deploy-mcp.yml` | `src/services/mcp/**` changes | mcp |
| `deploy-ui.yml` | `src/services/ui/**` changes | ui |
| `deploy.yml` | Any `src/**` changes (legacy) | All services |

### Path-Based Auto-Deployment

When you push changes to `main`:
- Changes to `platform/auth/keycloak/**` → Only Keycloak deploys
- Changes to `platform/data/postgres/**` → Only database deploys
- Changes to `src/services/api/**` → Only API service deploys
- Changes to `src/services/ai/**` → Only AI service deploys
- Changes to `src/services/mcp/**` → Only MCP service deploys
- Changes to `src/services/ui/**` → Only UI service deploys

## Let's Encrypt Configuration

**Certificate Rate Limits**

- `make deploy-*` uses **STAGING** certificates by default (not trusted, unlimited)
- `make deploy-infra-production` uses **PRODUCTION** certificates (trusted, rate-limited)
- Rate limits: 5 failures/hour, 50 certs/week

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

**API (deploy-api):**
- **api** - API Gateway

**AI (deploy-ai):**
- **ai** - AI service

**MCP (deploy-mcp):**
- **mcp** - MCP Gateway

### Networks
- **hill90_edge** - Public-facing (traefik, api, ai, mcp, keycloak, ui)
- **hill90_internal** - Private services (postgres, keycloak, all apps)

### Dependencies
- Deploy order: infra → db → auth (Keycloak) → remaining app services

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
