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
- **VPS Tailscale IP:** 100.68.116.66 (USE THIS for SSH)
- SSH as: `deploy` user (or `root` after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- You can run ANY command on the VPS via SSH
- **ALWAYS use Tailscale IP for SSH:** `ssh -i ~/.ssh/remote.hill90.com deploy@100.68.116.66`

### 3. Makefile Commands
All operations are done via Makefile - check `make help` for full list:
- `make tailscale-setup` - Automated Tailscale setup (Terraform + secrets)
- `make rebuild-bootstrap VPS_IP=<ip> ROOT_PASSWORD=<pw>` - Bootstrap VPS after rebuild
- `make deploy` - Deploy all services
- `make health` - Check service health
- `make ssh` - SSH to VPS

## VPS Rebuild Workflow (YOU Execute This)

When the VPS needs to be rebuilt from scratch:

```bash
# 1. Setup Tailscale infrastructure (one-time, or when auth key expires)
make tailscale-setup
# This automatically:
# - Initializes Terraform
# - Generates auth key
# - Stores in encrypted secrets
# All done! No manual steps.

# 2. Generate root password
ROOT_PASSWORD=$(openssl rand -base64 32)

# 3. Rebuild OS via MCP
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# Parameters:
#   - virtualMachineId: 1264324
#   - template_id: 1183 (AlmaLinux 10)
#   - password: $ROOT_PASSWORD

# 4. Wait ~5 minutes for rebuild

# 5. Get new VPS IP from MCP response

# 6. Bootstrap VPS (this does EVERYTHING automatically)
make rebuild-bootstrap VPS_IP=<new_ip> ROOT_PASSWORD="$ROOT_PASSWORD"
# This automatically:
# - Updates Ansible inventory (VPS IP)
# - Updates encrypted secrets (VPS_IP via SOPS set)
# - Creates deploy user
# - Installs Docker
# - Configures firewall (80/443, SSH via Tailscale only)
# - Hardens SSH
# - Installs Tailscale binary
# - Joins Tailscale network using auth key from secrets
# - Installs git
# - Clones repository to /opt/hill90/app
# - Transfers age key (via Ansible)
# - Sets up secrets

# 7. Deploy services (via SSH to Tailscale IP)
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip> 'cd /opt/hill90/app && make deploy'

# 8. Verify health
make health
```

**That's it. THREE commands: `make tailscale-setup` (one-time), `make rebuild-bootstrap`, deploy.**

All steps are fully automated - no manual Terraform, no manual secrets editing, no manual key copying.

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
- **Local (project):** `infra/secrets/keys/age-prod.key` (tracked in repo, used by scripts)
- **VPS:** `/opt/hill90/secrets/keys/keys.txt`
- **Symlinked on VPS:** `/opt/hill90/app/infra/secrets/keys/age-prod.key` → `/opt/hill90/secrets/keys/keys.txt`

**Note:** Scripts automatically use the project-local key. No manual configuration needed.

### Reading Secrets (Local)
```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key
sops -d infra/secrets/prod.enc.env | grep <VARIABLE_NAME>

# Or extract specific value
sops -d --extract '["VARIABLE_NAME"]' infra/secrets/prod.enc.env
```

### Editing Secrets (The CORRECT Way)

**Method 1: Interactive editing**
```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key
sops infra/secrets/prod.enc.env
# SOPS will decrypt, open in editor, and re-encrypt automatically
```

**Method 2: Programmatic updates (PREFERRED for automation)**
```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key

# Update single value atomically (NO temp files!)
sops --set '["VPS_IP"] "76.13.26.69"' infra/secrets/prod.enc.env

# Execute command with decrypted environment (NO temp files!)
sops exec-env infra/secrets/prod.enc.env 'echo $VPS_IP'
```

**CORRECT patterns used in scripts:**
- ✅ `sops --set '["KEY"] "value"' file.enc.env` - Atomic updates
- ✅ `sops exec-env file.enc.env 'command'` - Run commands with secrets
- ✅ `sops -d --extract '["KEY"]' file.enc.env` - Extract single value

**WRONG - DO NOT do this:**
- ❌ Decrypt to /tmp → sed → re-encrypt (fragile, leaves temp files)
- ❌ `sops -d > temp.env && sed ... && sops -e` (corruption risk)
- ❌ Manual decrypt/encrypt cycles

If SOPS fails, restore from git: `git checkout HEAD -- infra/secrets/prod.enc.env`

## Tailscale Management

### Automated Setup (ONE Command)
Tailscale infrastructure is fully automated via `make tailscale-setup`:

```bash
# Setup Tailscale (Terraform + secrets) - FULLY AUTOMATED
make tailscale-setup
# This command:
# 1. Initializes Terraform
# 2. Generates pre-authorized auth key (90-day expiry)
# 3. Extracts the key from Terraform output
# 4. Stores it in encrypted secrets automatically
# DONE! No manual steps required.

# Rotate auth key when expired (90 days)
make tailscale-rotate
# Same as tailscale-setup, generates new key and updates secrets
```

**Manual Terraform operations (NOT needed, use make targets instead):**
```bash
# If you need to manually inspect:
cd infra/terraform/tailscale
terraform output -raw vps_auth_key  # View current auth key
terraform state list                # View Terraform resources
```

### VPS Installation (Automated via Ansible)
The bootstrap process automatically:
1. Installs Tailscale binary (via Ansible playbook 05-tailscale.yml)
2. Joins Tailscale network using auth key from secrets
3. Configures firewall to allow SSH from Tailscale network only (100.64.0.0/10)
4. Saves Tailscale IP to `/opt/hill90/.tailscale_ip`

### SSH via Tailscale
```bash
# Get Tailscale IP from VPS
ssh -i ~/.ssh/remote.hill90.com root@<public-ip> 'cat /opt/hill90/.tailscale_ip'

# SSH via Tailscale IP (ALWAYS use this)
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>

# Public SSH is BLOCKED by firewall
```

### Tailscale Configuration
- **Auth key:** Generated by Terraform, expires in 90 days
- **API key:** Used by Terraform provider (in terraform.tfvars)
- **Firewall:** SSH allowed only from Tailscale CGNAT range (100.64.0.0/10)
- **Tags:** VPS tagged as `tag:server`, `tag:hill90`

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

**DON'T PANIC. Just rebuild (3 commands):**

```bash
# 1. Ensure Tailscale auth key is current (one-time or if expired)
make tailscale-setup  # AUTOMATED: Terraform + secrets

# 2. Rebuild VPS
ROOT_PASSWORD=$(openssl rand -base64 32)
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# virtualMachineId: 1264324, template_id: 1183, password: $ROOT_PASSWORD

# 3. Bootstrap (AUTOMATED: everything configured automatically)
make rebuild-bootstrap VPS_IP=<new_ip> ROOT_PASSWORD="$ROOT_PASSWORD"

# Done! SSH via Tailscale IP and deploy.
```

**YOU can fix anything because YOU control the entire stack.**

**100% Automated - Zero Manual Steps:**
- ✅ Tailscale auth key: `make tailscale-setup` (Terraform + secrets)
- ✅ Ansible installs Tailscale binary and joins network
- ✅ Firewall configured automatically (Tailscale network only)
- ✅ Age key transferred automatically via Ansible
- ✅ Secrets updated atomically via SOPS (no temp files)
- ✅ Repository cloned automatically
- ✅ All environment variables set correctly
- ✅ Deploy user created with correct permissions

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
