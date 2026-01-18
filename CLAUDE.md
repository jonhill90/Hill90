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
- **Everything is done via Makefile commands**

## CRITICAL RULES - READ FIRST

### ⚠️ NEVER DEPLOY LOCALLY ⚠️

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

## Your Capabilities

### 1. VPS Management (via MCP Tools)
You have direct access to Hostinger VPS via MCP tools:
- `mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1` - Rebuild OS (DESTRUCTIVE)
- `mcp__MCP_DOCKER__VPS_getVirtualMachineDetailsV1` - Get VPS info
- Full VPS lifecycle management

### 2. SSH Access
- **VPS Public IP:** 76.13.26.69 (DO NOT USE - public SSH blocked)
- **VPS Tailscale IP:** 100.88.97.65 (USE THIS for SSH)
- SSH as: `deploy` user (or `root` after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- You can run ANY command on the VPS via SSH
- **ALWAYS use Tailscale IP for SSH:** `ssh -i ~/.ssh/remote.hill90.com deploy@100.88.97.65`

### 3. Makefile Commands
All operations are done via Makefile - check `make help` for full list:
- `make rebuild-bootstrap VPS_IP=<ip>` - Bootstrap VPS after rebuild
- `make deploy` - Deploy all services
- `make health` - Check service health
- `make twingate-setup` - Configure Twingate
- `make ssh` - SSH to VPS

## VPS Rebuild Workflow (YOU Execute This)

When the VPS needs to be rebuilt from scratch:

```bash
# 1. Generate root password
ROOT_PASSWORD=$(openssl rand -base64 32)

# 2. Rebuild OS via MCP
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# Parameters:
#   - virtualMachineId: 1264324
#   - template_id: 1183 (AlmaLinux 10)
#   - password: $ROOT_PASSWORD

# 3. Wait ~5 minutes for rebuild

# 4. Get new VPS IP from MCP response

# 5. Bootstrap VPS (this does EVERYTHING)
make rebuild-bootstrap VPS_IP=<new_ip> ROOT_PASSWORD="$ROOT_PASSWORD"
# This automatically:
# - Updates Ansible inventory
# - Updates encrypted secrets
# - Creates deploy user
# - Installs Docker
# - Configures firewall (80/443/22 only)
# - Hardens SSH
# - Installs git
# - Clones repository to /opt/hill90/app
# - Transfers age key
# - Sets up secrets

# 6. Deploy services
make deploy

# 7. Verify health
make health
```

**That's it. Three commands: MCP rebuild, make bootstrap, make deploy.**

## Daily Operations (YOU Execute These)

### Deploy Changes
```bash
make deploy    # Deploys to VPS
make health    # Checks everything is running
```

### View Logs (on VPS)
```bash
make ssh       # SSH to VPS
make logs      # All services
make logs-api  # API only
make logs-traefik  # Traefik only
```

### Restart Services (on VPS)
```bash
make restart        # All services
make restart-api    # API only
make restart-traefik # Traefik only
```

## Secrets Management

### Age Key Locations
- **Local:** `/Users/jon/source/repos/Personal/Hill90/infra/secrets/keys/age-prod.key`
- **VPS:** `/opt/hill90/secrets/keys/keys.txt`
- **Symlinked on VPS:** `/opt/hill90/app/infra/secrets/keys/age-prod.key` → `/opt/hill90/secrets/keys/keys.txt`

### Reading Secrets (Local)
```bash
export SOPS_AGE_KEY_FILE=/Users/jon/source/repos/Personal/Hill90/infra/secrets/keys/age-prod.key
cd /Users/jon/source/repos/Personal/Hill90
sops -d infra/secrets/prod.enc.env | grep <VARIABLE_NAME>
```

### Editing Secrets (The CORRECT Way)

**Method 1: Direct SOPS editing (for simple changes)**
```bash
export SOPS_AGE_KEY_FILE=/Users/jon/source/repos/Personal/Hill90/infra/secrets/keys/age-prod.key
cd /Users/jon/source/repos/Personal/Hill90/infra/secrets

# SOPS will decrypt, open in editor, and re-encrypt automatically
# For automated changes, use updatekeys or exec-file
sops prod.enc.env
```

**Method 2: Programmatic updates (for automation)**
```bash
export SOPS_AGE_KEY_FILE=/Users/jon/source/repos/Personal/Hill90/infra/secrets/keys/age-prod.key
cd /Users/jon/source/repos/Personal/Hill90/infra/secrets

# Use sops exec-file to run commands with decrypted secrets
sops exec-file prod.enc.env 'echo {} | jq ".VPS_IP = \"76.13.26.69\"" > prod.dec.env'
sops -e prod.dec.env > prod.enc.env
rm prod.dec.env
```

**WRONG - DO NOT do this:**
- Decrypt to /tmp and try to re-encrypt from there (path regex won't match)
- Try to manually manage SOPS metadata
- Get stuck in decrypt/encrypt loops

If SOPS fails, restore from git and try again: `git checkout HEAD -- infra/secrets/prod.enc.env`

## Tailscale Management

### Install on VPS
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@<vps-ip>
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey=<tskey-auth-...>
tailscale status
```

### SSH via Tailscale
Once Tailscale is running on VPS:
```bash
# Find VPS hostname in Tailscale network
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-hostname>

# Example: ssh -i ~/.ssh/remote.hill90.com deploy@srv1264324
```

### Tailscale Keys
- **Auth key:** Used to join VPS to Tailscale network (one-time)
- **API key:** Used for Terraform provider (optional)
- Keys stored in secrets

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

## When Things Break

**DON'T PANIC. Just rebuild:**

1. Rebuild OS via MCP
2. `make rebuild-bootstrap VPS_IP=<new_ip>`
3. `make deploy`
4. Done

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
4. **Use the Makefile** - All operations via `make` commands
5. **Bootstrap is automated** - git, clone, age key all automatic
6. **Commit often** - User values clean git history

## Baseline Status: ✅ ACHIEVED

The VPS baseline is complete:
1. ✅ VPS is bootstrapped (deploy user, Docker, firewall)
2. ✅ Services are deployed and healthy
3. ✅ **Tailscale SSH access works** (100.88.97.65)
4. ✅ Public SSH is locked down (firewall blocks port 22)

**Baseline achieved!** Ready to build the actual application.

**Note:** HTTPS currently rate-limited by Let's Encrypt (too many rebuilds). Will work after 2026-01-19 15:43:41 UTC.

---

**Remember: The user built this infrastructure FOR YOU to manage. Use it.**
