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

### Optimized Rebuild (FASTEST - 5-7 minutes)

**Use this for speed. Replaces Terraform with Tailscale API and uses optimized Ansible.**

```bash
# PHASE 1: Prepare for optimized rebuild
make rebuild-optimized

# This command:
# 1. Generates Tailscale auth key via API (NO Terraform!)
# 2. Generates secure root password
# 3. Displays MCP parameters (includes optional post-install script ID)
# 4. Saves state for phase 2

# PHASE 2: Run MCP tool (Claude Code only)
# Use MCP: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1
# Parameters displayed by script above
# OPTIONAL: Add post_install_script_id for binary pre-caching (saves 2-3 min)
# Wait ~5 minutes for rebuild to complete

# PHASE 3: Complete optimized rebuild (auto-detects IPs)
make rebuild-optimized-post-mcp VPS_IP=<new_ip>
# OR let it auto-detect: make rebuild-optimized-post-mcp

# This command automatically:
# 1. Updates VPS_IP in encrypted secrets
# 2. Bootstraps VPS with OPTIMIZED Ansible playbook
# 3. Queries Tailscale API for device IP (NO SSH chicken-and-egg!)
# 4. Updates TAILSCALE_IP in encrypted secrets
# 5. Deploys all services with PARALLEL Docker builds
# 6. Waits for services to start
# 7. Verifies health

# Done! VPS rebuilt in 5-7 minutes (vs 30 minutes).
```

**Key Optimizations:**
- ✅ **Tailscale API** - Replaces Terraform (saves 10-15 min)
- ✅ **Auto IP detection** - Queries Tailscale API for device IP (no SSH needed)
- ✅ **Consolidated Ansible** - Single playbook vs 9 sequential (saves 2-4 min)
- ✅ **Parallel Docker builds** - `docker compose build --parallel` (saves 1-2 min)
- ✅ **Binary pre-caching** - Post-install script caches Docker, SOPS, age (saves 2-3 min)

**Post-Install Script Setup (Optional - Saves 2-3 minutes):**

To enable binary pre-caching during OS rebuild:

1. Upload the post-install script to Hostinger:
   - Use MCP: `mcp__MCP_DOCKER__VPS_createPostInstallScriptV1`
   - Name: `hill90-cache-binaries`
   - Content: Contents of `infra/post-install/cache-binaries.sh`

2. Note the script ID returned by MCP

3. When running MCP rebuild, add `post_install_script_id: <script_id>`

The script will run during OS installation and pre-download Docker, SOPS, age, and git. Ansible will then use the cached binaries instead of downloading them.

**Total rebuild time: 5-7 minutes (vs 30 minutes with old method)**

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

**DON'T PANIC. Just rebuild (2 commands, 5-7 minutes):**

```bash
# FASTEST: Use optimized rebuild (5-7 minutes total)
make rebuild-optimized
# Run MCP rebuild as instructed
make rebuild-optimized-post-mcp VPS_IP=<new_ip>

# Done! Fully deployed in 5-7 minutes.
```

**OR use the original automated method (30 minutes):**

```bash
# 1. Prepare rebuild
make rebuild-full-auto

# 2. Run MCP rebuild as instructed

# 3. Complete rebuild
make rebuild-full-auto-post-mcp VPS_IP=<new_ip>

# Done! SSH via Tailscale IP.
```

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
