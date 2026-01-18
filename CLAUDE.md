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

## ⚠️ NO BLOCKERS - ONLY REBUILDS ⚠️

**IF ANYTHING IS BROKEN, REBUILD IMMEDIATELY. DO NOT REPORT. DO NOT WAIT.**

You encounter a problem → You REBUILD the VPS → Problem solved.

**NEVER do this:**
- ❌ "Cannot connect to Tailscale" → Report to user
- ❌ "SSH is down" → Wait for user to fix
- ❌ "Services won't start" → Ask user what to do
- ❌ "Need to troubleshoot X" → Investigate for 10 minutes

**ALWAYS do this:**
- ✅ Tailscale down → REBUILD VPS immediately
- ✅ SSH fails → REBUILD VPS immediately
- ✅ Services broken → REBUILD VPS immediately
- ✅ Config errors → REBUILD VPS immediately
- ✅ **ANY problem → REBUILD VPS immediately**

**Why:**
- Rebuild takes 10 minutes (3 commands)
- You have all the tools to rebuild
- The user is NOT your debugger
- The user is NOT your sysadmin
- YOU are the sysadmin
- You are paid to GET SHIT WORKING, not report problems

**The rebuild process is 2 commands:**
```bash
make rebuild-full-auto                     # 1. Prep + display MCP params
# YOU use MCP to rebuild OS                # 2. Rebuild via MCP (5 min)
make rebuild-full-auto-post-mcp VPS_IP=X   # 3. Bootstrap + deploy + verify
```

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
All operations are done via Makefile - check `make help` for full list.

**The Makefile is organized into logical sections:**
- **Infrastructure Setup** - Tailscale, secrets initialization (rare operations)
- **VPS Rebuild & Bootstrap** - Destructive rebuild operations
- **Development** - Local development environment
- **Deployment** - Build and deploy to VPS
- **Monitoring & Maintenance** - Health checks, logs, SSH
- **Service Management** - Start, stop, restart services
- **Database & Backups** - Backup operations

**Key commands:**
- `make help` - Show all available commands (organized by section)
- `make tailscale-setup` - Automated Tailscale setup (Terraform + secrets)
- `make rebuild-bootstrap VPS_IP=<ip> ROOT_PASSWORD=<pw>` - Bootstrap VPS after rebuild
- `make deploy` - Deploy all services (STAGING certificates)
- `make deploy-production` - Deploy with PRODUCTION certificates (rate-limited!)
- `make health` - Check service health
- `make ssh` - SSH to VPS
- `make secrets-view KEY=<key>` - View a secret value
- `make secrets-update KEY=<key> VALUE=<value>` - Update a secret

## VPS Rebuild Workflow (YOU Execute This)

### Fully Automated Rebuild (NEW - Recommended)

**SINGLE-COMMAND REBUILD (excluding MCP):**

```bash
# PHASE 1: Prepare for rebuild
make rebuild-full-auto

# This command:
# 1. Ensures Tailscale auth key is ready
# 2. Generates secure root password
# 3. Displays MCP parameters for you to use
# 4. Waits for MCP rebuild to complete

# PHASE 2: YOU run MCP tool (Claude Code only)
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# Parameters displayed by script above
# Wait ~5 minutes for rebuild to complete

# PHASE 3: Complete rebuild with new VPS IP
make rebuild-full-auto-post-mcp VPS_IP=<new_ip>

# This command automatically:
# 1. Updates VPS_IP in encrypted secrets
# 2. Bootstraps VPS with Ansible (all phases)
# 3. Retrieves Tailscale IP from VPS
# 4. Updates TAILSCALE_IP in encrypted secrets
# 5. Deploys all services via Tailscale
# 6. Waits for services to start
# 7. Verifies health

# Done! VPS is fully rebuilt and deployed.
```

**That's it. TWO commands: `make rebuild-full-auto`, then `make rebuild-full-auto-post-mcp VPS_IP=<new_ip>`**

### Manual Rebuild (Old Method - Still Works)

If you prefer step-by-step control:

```bash
# 1. Setup Tailscale infrastructure (one-time, or when auth key expires)
make tailscale-setup

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
# This automatically runs Ansible playbooks in the correct order:
#
# Phase 1: Base System Setup
# - Creates deploy user with sudo access
#
# Phase 2: Network Security (establish VPN access BEFORE locking down)
# - Configures firewall (HTTP/HTTPS, SSH still public temporarily)
# - Installs Tailscale binary and joins network
# - Locks SSH to Tailscale network ONLY (100.64.0.0/10)
# - Hardens SSH (disable root, password auth, fail2ban)
#
# Phase 3: Development Tools
# - Installs SOPS and age binaries
# - Installs git and clones repository to /opt/hill90/app
# - Transfers age encryption key via Ansible
#
# Phase 4: Application Runtime (LAST - separate infra from app)
# - Installs Docker and Docker Compose

# 7. Deploy services (via SSH to Tailscale IP)
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip> 'cd /opt/hill90/app && make deploy'

# 8. Verify health
make health
```

**All steps are fully automated - no manual Terraform, no manual secrets editing, no manual key copying.**

## Daily Operations (YOU Execute These)

### Deploy Changes
```bash
make deploy               # Deploys to VPS (STAGING certificates - safe for testing)
make deploy-production    # Deploys with PRODUCTION certificates (USE CAREFULLY - rate limited!)
make health               # Checks everything is running
```

**IMPORTANT: Let's Encrypt Configuration**
- `make deploy` uses **STAGING** certificates by default (not trusted by browsers, but unlimited rate limits)
- `make deploy-production` uses **PRODUCTION** certificates (trusted, but rate-limited: 5 failures/hour, 50 certs/week)
- Always test with staging first, only use production when ready for real traffic
- If you hit rate limits, you're locked out until the limit expires (up to 1 week for duplicate certs)

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

### Viewing Secrets (RECOMMENDED - Safe, no temp files)

**Using Makefile commands (easiest):**
```bash
make secrets-view                    # View all secrets
make secrets-view KEY=VPS_IP         # View specific secret
```

**Using scripts directly:**
```bash
bash scripts/secrets-view.sh infra/secrets/prod.enc.env              # All secrets
bash scripts/secrets-view.sh infra/secrets/prod.enc.env VPS_IP       # Specific secret
```

### Updating Secrets (RECOMMENDED - Safe, automatic backup)

**Using Makefile commands (easiest):**
```bash
make secrets-update KEY=VPS_IP VALUE="76.13.26.69"
# Creates automatic backup before update
# Restores from backup if update fails
```

**Using scripts directly:**
```bash
bash scripts/secrets-update.sh infra/secrets/prod.enc.env VPS_IP "76.13.26.69"
```

### Editing Secrets Interactively

**Using Makefile (easiest):**
```bash
make secrets-edit    # Opens in your default editor
```

**Using SOPS directly:**
```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key
sops infra/secrets/prod.enc.env
# SOPS will decrypt, open in editor, and re-encrypt automatically
```

### Advanced: Programmatic Updates (for scripts)

```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key

# Update single value atomically (NO temp files!)
sops --set '["VPS_IP"] "76.13.26.69"' infra/secrets/prod.enc.env

# Execute command with decrypted environment (NO temp files!)
sops exec-env infra/secrets/prod.enc.env 'echo $VPS_IP'

# Extract specific value
sops -d --extract '["VPS_IP"]' infra/secrets/prod.enc.env
```

### Best Practices

**RECOMMENDED approaches:**
- ✅ `make secrets-view KEY=<key>` - Safe viewing
- ✅ `make secrets-update KEY=<key> VALUE=<value>` - Safe updates with auto-backup
- ✅ `make secrets-edit` - Interactive editing
- ✅ `bash scripts/secrets-*.sh` - Helper scripts with safety checks

**AVOID:**
- ❌ Direct `sops -d` to temp files (leaves unencrypted secrets on disk)
- ❌ Manual decrypt → edit → encrypt cycles (corruption risk)
- ❌ Using `sed` or other text tools on encrypted files

**If something goes wrong:**
```bash
git checkout HEAD -- infra/secrets/prod.enc.env    # Restore from git
# Or restore from backup created by secrets-update.sh
```

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

## GitHub Actions Migration (Future Work)

### Current State: Automation from Mac

All automation currently runs from your Mac via Claude Code:
- ✅ Fully automated rebuild via `make rebuild-full-auto`
- ✅ Fully automated secrets generation
- ✅ Automated bootstrap, deploy, and health checks
- ✅ All scripts are repeatable and idempotent

### Future: GitHub Actions Runners

Workflow skeletons are ready in `.github/workflows/`:

**`.github/workflows/rebuild-vps.yml`**
- Manual trigger (workflow_dispatch) for VPS rebuilds
- Will use Hostinger API instead of MCP tools
- Requires GitHub Secrets for API keys and SSH keys

**`.github/workflows/deploy.yml`**
- Triggers on push to main
- Validates infrastructure before deploy
- SSHs to VPS via Tailscale and deploys
- Runs health checks after deployment

### Migration Path

When ready to migrate to GitHub Actions:

1. **Secrets Migration**
   - Add all secrets from `prod.enc.env` to GitHub Secrets
   - Add Hostinger API key
   - Add VPS SSH private key
   - Add Tailscale auth key
   - Add SOPS age key

2. **Implement Workflows**
   - Remove placeholder steps
   - Implement actual deployment steps
   - Add Tailscale setup in runners
   - Add health check verification

3. **Benefits**
   - No local dependencies (runs on GitHub)
   - Audit trail via GitHub Actions logs
   - Can trigger from anywhere
   - Automatic deployments on push

**For now, continue using Mac-based automation via Claude Code.**

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
