# Deployment Reference

## Deployment Location

**Deployments must run on the VPS via SSH, not on the local Mac.**

When deploying:
```bash
# Correct - Run deploy script on the VPS via SSH
ssh -i ~/.ssh/remote.hill90.com deploy@<vps-ip> 'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod'

# Incorrect - deploys locally instead of on VPS
make deploy  # This runs locally on Mac, not on VPS
bash scripts/deploy.sh prod  # This runs locally, not on VPS
```

The deploy script builds and runs Docker containers **wherever you execute it**, so SSH to the VPS first to ensure proper deployment.

## Deploy Changes

### Local Deployment

```bash
make deploy               # Deploys to VPS (STAGING certificates - safe for testing)
make deploy-production    # Deploys with PRODUCTION certificates (USE CAREFULLY - rate limited!)
make health               # Checks everything is running
```

### GitHub Actions Deployment

**Deployment is separated from VPS rebuild to prevent Let's Encrypt rate limit issues.**

Two deployment workflows available:

#### Staging Deployment (Unlimited Certificates)

- Workflow: `.github/workflows/deploy-staging.yml`
- **Triggers:** Push to `dev` or `stage` branches, manual dispatch
- **Certificates:** Let's Encrypt STAGING (browser warnings expected)
- **Rate limit:** Unlimited (safe for testing)
- **Use for:** Testing, development, VPS rebuild validation

**How to trigger manually:**
1. Go to Actions → Deploy (Staging Certificates)
2. Click "Run workflow"
3. Select environment: `prod`
4. Click "Run workflow"

#### Production Deployment (Rate-Limited Certificates)

- Workflow: `.github/workflows/deploy-production.yml`
- **Triggers:** Push to `main` branch (auto), manual dispatch (requires confirmation)
- **Certificates:** Let's Encrypt PRODUCTION (trusted by browsers)
- **Rate limit:** 50 certificates/week, 5 failures/hour
- **Use for:** Production deployments only

**How to trigger manually:**
1. Go to Actions → Deploy (Production Certificates)
2. Click "Run workflow"
3. Type "PRODUCTION" exactly to confirm
4. Click "Run workflow"

**Auto-deployment:** Pushes to `main` branch automatically trigger production deployment.

#### VPS Recreate No Longer Includes Deployment

- **Important:** `.github/workflows/recreate-vps.yml` now stops after infrastructure bootstrap
- No services are deployed, no certificates are requested
- After VPS recreate, manually trigger staging or production deployment workflow
- This prevents hitting Let's Encrypt rate limits when testing VPS rebuilds

## Let's Encrypt Configuration

**Certificate Rate Limits**

- `make deploy` uses **STAGING** certificates by default (not trusted by browsers, but unlimited rate limits)
- `make deploy-production` uses **PRODUCTION** certificates (trusted, but rate-limited: 5 failures/hour, 50 certs/week)
- Always test with staging first, only use production when ready for real traffic
- If you hit rate limits, you're locked out until the limit expires (up to 1 week for duplicate certs)

## Architecture

### Services (Docker Compose)
1. **traefik** - Edge proxy (80/443)
2. **api** - TypeScript API service
3. **ai** - Python AI service
4. **mcp** - TypeScript MCP service
5. **auth** - TypeScript auth service
6. **postgres** - PostgreSQL database

### Host Services
- **Tailscale** - VPN for secure SSH access

### Networks
- **edge** - Public-facing (traefik)
- **internal** - Private services (postgres, auth, api, ai, mcp)

### Firewall
- **Public:** 80/tcp, 443/tcp
- **SSH (22/tcp):** Tailscale-only (blocked from public internet)

## Traefik Dashboard Authentication

The Traefik dashboard at `https://traefik.hill90.com` uses basic authentication.

**Credentials are automatically generated during deployment:**

1. Password hash stored in: `TRAEFIK_ADMIN_PASSWORD_HASH` (encrypted in secrets)
2. Deploy script generates: `deployments/platform/edge/dynamic/.htpasswd`
3. File format: `admin:$2y$05$...` (bcrypt hash)

**How it works:**

```bash
# During deployment (scripts/deploy.sh):
echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > deployments/platform/edge/dynamic/.htpasswd

# Traefik reads this file via:
# deployments/platform/edge/dynamic/middlewares.yml
auth:
  basicAuth:
    usersFile: /etc/traefik/dynamic/.htpasswd
```

**Access credentials:**
- Username: `admin`
- Password: Stored in user's password manager (not in repo)
- Hash: `TRAEFIK_ADMIN_PASSWORD_HASH` in encrypted secrets

**If you need to reset the password:**
1. Generate new password: `openssl rand -base64 20 | tr -d '/+=' | cut -c1-20`
2. Generate bcrypt hash: `htpasswd -nbB admin "<password>" | cut -d: -f2`
3. Update secret: `sops --set '["TRAEFIK_ADMIN_PASSWORD_HASH"] "$2y$...' infra/secrets/prod.enc.env`
4. Redeploy: `make deploy`

## File Locations

### Local (Your Machine)
- Repository: `/Users/jon/source/repos/Personal/Hill90`
- Age key: `~/.config/sops/age/keys.txt`
- SSH key: `~/.ssh/remote.hill90.com`

### VPS
- App directory: `/opt/hill90/app`
- Age key: `/opt/hill90/secrets/keys/keys.txt`
- Deploy user: `deploy`
- Services: Docker Compose in `/opt/hill90/app`
- Traefik dynamic config: `/opt/hill90/app/deployments/platform/edge/dynamic/`
