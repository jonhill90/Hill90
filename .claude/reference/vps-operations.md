# VPS Operations Reference

## VPS Rebuild Workflow

### Fully Automated Rebuild (Recommended)

**SINGLE-COMMAND REBUILD (excluding MCP):**

```bash
# PHASE 1: Prepare for rebuild
make rebuild-full-auto

# This command:
# 1. Ensures Tailscale auth key is ready
# 2. Generates secure root password
# 3. Displays MCP parameters for you to use
# 4. Waits for MCP rebuild to complete

# PHASE 2: Run MCP tool (Claude Code only)
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

### Optimized Rebuild v2 (Recommended - 12-15 minutes)

**Use this for flexibility and reliability. Prioritizes idempotency over speed.**

**Architecture v2:**
- **Minimal post-install script**: Installs only Python, git, basic tools
- **Comprehensive Ansible playbook**: Installs Docker, SOPS, age, configures everything
- **Idempotent bootstrap**: If Ansible fails, just re-run it (no OS rebuild needed!)
- **Tailscale API**: No Terraform needed
- **Auto IP detection**: Queries Tailscale API for device IP

```bash
# PHASE 1: Prepare for optimized rebuild
make rebuild-optimized

# This command:
# 1. Generates Tailscale auth key via API (NO Terraform!)
# 2. Generates secure root password
# 3. Displays MCP parameters (includes post-install script ID: 2396)
# 4. Saves state for phase 2

# PHASE 2: Run MCP tool (Claude Code only)
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# Parameters displayed by script above
# REQUIRED: post_install_script_id: 2396 (bootstrap-ansible-v2)
# Wait ~10 minutes for rebuild to complete

# PHASE 3: Complete infrastructure rebuild (auto-detects IPs)
make rebuild-optimized-post-mcp VPS_IP=<new_ip>

# This command automatically:
# 1. Updates VPS_IP in encrypted secrets
# 2. Bootstraps VPS with v2 Ansible playbook (installs Docker, SOPS, age, etc.)
# 3. Queries Tailscale API for device IP (NO SSH chicken-and-egg!)
# 4. Updates TAILSCALE_IP in encrypted secrets
# STOPS HERE - Infrastructure ready, application NOT deployed

# PHASE 4: Deploy application (separate step)
make deploy

# This command:
# 1. Builds Docker images on VPS
# 2. Starts containers
# 3. Verifies health

# Done! Full rebuild + deploy in 12-15 minutes.
```

**Key Features:**
- ✅ **Minimal post-install** - Only Python/git (easy to debug)
- ✅ **Comprehensive Ansible** - All tools installed via playbook
- ✅ **Idempotent** - Can re-run Ansible without OS rebuild if it fails
- ✅ **Tailscale API** - Replaces Terraform
- ✅ **Auto IP detection** - Queries Tailscale API for device IP
- ✅ **Flexible** - Easy to update tool versions without OS rebuild

**Post-Install Script (REQUIRED):**

The post-install script ID **2396** (bootstrap-ansible-v2) is stored in secrets:

```bash
# View the current post-install script ID
make secrets-view KEY=HOSTINGER_POST_INSTALL_SCRIPT_ID
# Output: HOSTINGER_POST_INSTALL_SCRIPT_ID=2396
```

This script installs only Python, pip, git, curl, and sudo. Everything else (Docker, SOPS, age, Tailscale) is installed by the v2 Ansible playbook.

**If Ansible fails during bootstrap:**

```bash
# Re-run Ansible WITHOUT rebuilding the OS!
cd infra/ansible
export TAILSCALE_AUTH_KEY=$(make secrets-view KEY=TAILSCALE_AUTH_KEY | grep TAILSCALE | cut -d= -f2)
ansible-playbook -i inventory/hosts.ini \
  -e "ansible_host=<vps-ip>" \
  -e "ansible_user=root" \
  -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
  -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
  playbooks/bootstrap-v2.yml
```

**Total rebuild time: 12-15 minutes (acceptable for flexibility benefits)**

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

## When Things Break

**DON'T PANIC. Rebuild is often the fastest solution.**

### Option 1: Full OS Rebuild (v2)

```bash
# Use when: OS issues, SSH lockout, infrastructure problems

# Rebuild infrastructure (12-15 min)
make rebuild-optimized
# Run MCP rebuild as instructed
make rebuild-optimized-post-mcp VPS_IP=<new_ip>

# Deploy application (2-3 min)
make deploy

# Done! Infrastructure + app in ~15 minutes.
```

### Option 2: Just Re-run Ansible (2-3 minutes)

**NEW in v2: If only Ansible failed (Docker not installed, tool missing, etc.), you can re-run JUST Ansible without rebuilding the OS!**

```bash
# Re-run Ansible bootstrap WITHOUT OS rebuild
cd infra/ansible
export TAILSCALE_AUTH_KEY=$(make secrets-view KEY=TAILSCALE_AUTH_KEY | grep TAILSCALE | cut -d= -f2)
ansible-playbook -i inventory/hosts.ini \
  -e "ansible_host=<vps-ip>" \
  -e "ansible_user=root" \
  -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
  -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
  playbooks/bootstrap-v2.yml

# Takes 2-3 minutes instead of 12-15 for full rebuild!
```

**When to use Ansible-only vs full rebuild:**
- **Ansible only**: Docker not installed, tool missing, service config issue
- **Full rebuild**: SSH locked out, OS corruption, Tailscale problems, public IP changed

**Full control of the stack enables fixing any infrastructure issue.**

**100% Automated - Zero Manual Steps:**
- ✅ Tailscale auth key: `make tailscale-setup` (Terraform + secrets)
- ✅ Ansible installs Tailscale binary and joins network
- ✅ Firewall configured automatically (Tailscale network only)
- ✅ Age key transferred automatically via Ansible
- ✅ Secrets updated atomically via SOPS (no temp files)
- ✅ Repository cloned automatically
- ✅ All environment variables set correctly
- ✅ Deploy user created with correct permissions

## VPS Information

- **VPS ID**: 1264324
- **Template ID**: 1183 (AlmaLinux 10)
- **VPS Public IP**: 76.13.26.69 (not for SSH - public SSH blocked)
- **VPS Tailscale IP**: 100.68.116.66 (use this for SSH)
- **SSH Key**: `~/.ssh/remote.hill90.com`
- **Deploy User**: `deploy` (or `root` immediately after rebuild)

## Service Management Commands

```bash
# Restart services (on VPS)
make restart        # All services
make restart-api    # API only
make restart-traefik # Traefik only

# View logs (on VPS)
make ssh       # SSH to VPS
make logs      # All services
make logs-api  # API only
make logs-traefik  # Traefik only

# Health checks
make health    # Check all services
```
