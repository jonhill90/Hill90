# Deployment Reference

## ⚠️ CRITICAL: NEVER DEPLOY LOCALLY ⚠️

**DEPLOYMENTS ALWAYS RUN ON THE VPS, NEVER ON THE USER'S MAC.**

When deploying:
```bash
# CORRECT - Run deploy script ON THE VPS via SSH
ssh -i ~/.ssh/remote.hill90.com deploy@<vps-ip> 'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod'

# WRONG - NEVER DO THIS
make deploy  # This runs LOCALLY on Mac, NOT on VPS
bash scripts/deploy.sh prod  # This runs LOCALLY, NOT on VPS
```

The deploy script builds and runs Docker containers **wherever you execute it**. You must SSH to the VPS first.

## Deploy Changes

```bash
make deploy               # Deploys to VPS (STAGING certificates - safe for testing)
make deploy-production    # Deploys with PRODUCTION certificates (USE CAREFULLY - rate limited!)
make health               # Checks everything is running
```

## Let's Encrypt Configuration

**IMPORTANT: Certificate Rate Limits**

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
