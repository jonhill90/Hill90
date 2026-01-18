# Claude Code Operating Manual for Hill90 VPS

**READ THIS FIRST when working on this project.**

## Core Principle

**YOU (Claude Code) manage this VPS, not the user.**

- YOU have SSH access to the VPS
- YOU have MCP tools to rebuild the VPS OS
- YOU can install, configure, and deploy everything
- If YOU break something, YOU can just reinstall the OS and start over
- The user asks YOU to do things, YOU do them
- NEVER ask the user to run commands - YOU run them

## Your Capabilities

### 1. VPS Management (via MCP Tools)
You have direct access to Hostinger VPS via MCP tools:
- `mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1` - Rebuild OS (DESTRUCTIVE)
- `mcp__MCP_DOCKER__VPS_createSnapshotV1` - Create snapshot backup
- `mcp__MCP_DOCKER__VPS_getVirtualMachineDetailsV1` - Get VPS info
- Full VPS lifecycle management

### 2. SSH Access
- VPS IP: Check `infra/ansible/inventory/hosts.yml`
- SSH as: `deploy` user (or `root` after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- You can run ANY command on the VPS via SSH

### 3. Local Tools
- Terraform (Hostinger VPS, Twingate infrastructure)
- Ansible (VPS bootstrapping)
- SOPS/age (secrets encryption)
- Docker Compose (service orchestration)
- Git (this repository)

## VPS Rebuild Workflow (YOU Execute This)

When the VPS needs to be rebuilt:

```bash
# 1. Create snapshot first
# Use MCP: mcp__MCP_DOCKER__VPS_createSnapshotV1
# Note: Only 1 snapshot per VPS (overwrites existing)

# 2. Generate root password
ROOT_PASSWORD=$(openssl rand -base64 32)
# Save this temporarily

# 3. Rebuild OS via MCP
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# Parameters:
#   - virtualMachineId: Get from Terraform state
#   - template_id: AlmaLinux 10
#   - password: The generated password

# 4. Wait ~5 minutes for rebuild

# 5. Get new VPS IP from MCP response

# 6. SSH to VPS and run bootstrap
cd /Users/jon/source/repos/Personal/Hill90
bash scripts/vps-bootstrap-from-rebuild.sh "$ROOT_PASSWORD" "$NEW_VPS_IP"

# This script automatically:
# - Updates Ansible inventory
# - Updates encrypted secrets
# - Runs Ansible bootstrap (user, docker, firewall, SSH, secrets)
# - Installs git
# - Clones repository
# - Transfers age key from local machine
# - VPS ready for deployment

# 7. Deploy services
make deploy

# 8. Verify health
make health
```

**YOU run all these commands. The user doesn't.**

## Daily Operations (YOU Execute These)

### Deploy Changes
```bash
# SSH to VPS
ssh deploy@<vps-ip>

# Pull latest code
cd /opt/hill90/app
git pull

# Deploy
cd /opt/hill90/app
make deploy

# Check health
make health
```

### View Logs
```bash
ssh deploy@<vps-ip>
cd /opt/hill90/app
docker logs -f <service-name>
# Services: traefik, api, ai, mcp, auth, postgres, twingate
```

### Restart Services
```bash
ssh deploy@<vps-ip>
cd /opt/hill90/app
docker compose -f deployments/compose/prod/docker-compose.yml restart <service>
```

## Secrets Management

### Decrypt Secrets (Local)
```bash
sops -d infra/secrets/prod.enc.env > /tmp/prod.dec.env
# Edit /tmp/prod.dec.env
sops -e /tmp/prod.dec.env > infra/secrets/prod.enc.env
rm /tmp/prod.dec.env
```

### Age Key Location
- **Local:** `~/.config/sops/age/keys.txt`
- **VPS:** `/opt/hill90/secrets/keys/keys.txt`
- **Auto-transferred** during bootstrap

## Twingate Management

### Apply Terraform
```bash
cd infra/terraform/twingate
terraform init
terraform apply

# Tokens are in outputs
terraform output twingate_access_token
terraform output twingate_refresh_token
```

### Inject Tokens to Secrets
```bash
bash scripts/twingate-inject-tokens.sh
# Automatically reads Terraform outputs and updates prod.enc.env
```

### Twingate Resources
- **PostgreSQL** (`postgres`) - Internal database
- **Auth Service** (`auth`) - Internal API
- **API Service** (`api`) - Debugging
- **AI Service** (`ai`) - Debugging
- **MCP Service** (`mcp`) - Debugging
- **VPS SSH** (`hill90-vps.internal`) - Host SSH access

**Current blocker:** SSH routing via Twingate DNS not working

## Architecture

### Services (Docker Compose)
1. **traefik** - Edge proxy (80/443)
2. **api** - TypeScript API service
3. **ai** - Python AI service
4. **mcp** - TypeScript MCP service
5. **auth** - TypeScript auth service
6. **postgres** - PostgreSQL database
7. **twingate** - Zero-trust connector

### Networks
- **edge** - Public-facing (traefik, twingate)
- **internal** - Private services (postgres, auth, twingate)

### Firewall
- **Public:** 80/tcp, 443/tcp only
- **SSH (22/tcp):** Currently public (SHOULD BE Twingate-only, blocked by AI-29)

## Current Blockers

### CRITICAL: AI-29 - Twingate SSH Routing
- **Problem:** Can't resolve `hill90-vps.internal` from local machine
- **Attempts:**
  1. `172.18.0.1` (Docker gateway) → Timeout
  2. `srv1264324.hstgr.cloud` (hostname) → Worked via public, failed when SSH removed
  3. `localhost` → Connection refused
  4. `hill90-vps.internal` → DNS resolution failure
- **Blocking:** AI-30 (firewall lock-down)

## When Things Break

**DON'T PANIC. Just rebuild:**

1. Snapshot the VPS (if it's still accessible)
2. Rebuild OS via MCP
3. Run bootstrap script
4. Deploy
5. Done

**YOU can fix anything because YOU control the entire stack.**

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

## Important Reminders

1. **YOU SSH to the VPS** - Never ask user to SSH
2. **YOU use MCP tools** - You can rebuild the OS
3. **YOU run commands** - User doesn't run anything
4. **Security first** - Twingate-only SSH when AI-29 resolved
5. **Bootstrap is automated** - git, clone, age key all automatic
6. **Commit often** - User values clean git history

## Linear Issues (Current State)

- **AI-26** 🚧 In Progress - Twingate integration (95% done, DNS blocker)
- **AI-29** 🚧 In Progress - Twingate SSH routing (CRITICAL blocker)
- **AI-30** 📋 Todo - Remove public SSH (blocked on AI-29)
- **AI-31** 🔍 In Review - Rebuild automation (needs runbook)
- **AI-32** 📋 Todo - Update README (remove Tailscale, add Twingate)
- **AI-27** ✅ Done - Git/clone automation
- **AI-28** ✅ Done - Age key automation
- **AI-33** ✅ Done - Health check DNS verification

## Next Steps (When AI-29 Resolved)

1. Verify Twingate SSH access works
2. Remove public SSH (firewall lock-down)
3. Create VPS rebuild runbook
4. Update README documentation
5. User can start building their application

---

**Remember: The user built this infrastructure FOR YOU to manage. Use it.**
