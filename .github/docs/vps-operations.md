# VPS Operations Reference

## VPS Rebuild Options

The VPS rebuild is fully automated with **zero manual intervention** required.

Two rebuild options are available:

- **Option A: Local Execution (Recommended)** - Faster, simpler, no GitHub UI needed
- **Option B: GitHub Actions** - Remote execution, full audit trail, accessible from anywhere

Both options use the same underlying automation and produce identical results.

## Option A: Local Rebuild (Recommended)

**Preferred method for speed and simplicity.**

### Complete Rebuild Workflow (4 Steps)

```bash
# Step 1: Rebuild VPS OS (auto-waits, auto-retrieves IP, auto-updates secrets)
make recreate-vps

# Step 2: Bootstrap OS (auto-extracts Tailscale IP, auto-updates secrets)
# NOTE: This only configures the OS - no containers deployed!
make config-vps VPS_IP=<ip>

# Step 3: Deploy infrastructure (Traefik, dns-manager, Portainer)
make deploy-infra

# Step 4: Deploy application services
make deploy-all  # All services
# OR deploy individually:
make deploy-auth  # Auth + PostgreSQL
make deploy-api   # API service
make deploy-ai    # AI service
make deploy-mcp   # MCP service
```

### What Happens Automatically

**Step 1: `make recreate-vps`** (~3-5 minutes):
1. Generates new Tailscale auth key via API
2. Updates TAILSCALE_AUTH_KEY secret
3. Generates random root password
4. Rebuilds VPS via Hostinger API
5. **Waits for rebuild to complete** (~135s)
6. **Retrieves new VPS IP automatically**
7. **Updates VPS_IP secret automatically**
8. Displays next command to run

**Step 2: `make config-vps VPS_IP=<ip>`** (~3-5 minutes):
1. Runs Ansible bootstrap (8 stages)
   - System setup (deploy user, directories)
   - Firewall configuration
   - Tailscale installation and join
   - SSH lockdown (Tailscale-only access)
   - Docker installation
   - SOPS and age installation
   - Repository clone
   - Secrets transfer
2. **Extracts Tailscale IP from Ansible output**
3. **Updates TAILSCALE_IP secret automatically**
4. **NO containers deployed** - OS ready for containers

**Step 3: `make deploy-infra`** (~2-3 minutes):
1. Creates Docker networks (hill90_edge, hill90_internal)
2. Generates Traefik .htpasswd file
3. Deploys Traefik (reverse proxy with SSL)
4. Deploys dns-manager (DNS-01 ACME challenges)
5. Deploys Portainer (container management)

**Step 4: `make deploy-all`** (~2-3 minutes):
1. Deploys auth + postgres
2. Deploys api
3. Deploys ai
4. Deploys mcp
5. Verifies all services running

### Infrastructure After Each Step

**After Step 2 (Config VPS):**
- ✅ Docker 29.1.5 + Compose v5.0.1 installed
- ✅ SOPS 3.8.1 + age 1.1.1 installed
- ✅ Tailscale connected
- ✅ SSH locked to Tailscale network only
- ✅ Firewall configured (HTTP/HTTPS public, SSH Tailscale-only)
- ✅ Repository cloned to `/opt/hill90/app`
- ✅ Age key transferred to `/opt/hill90/secrets/keys/keys.txt`
- ❌ **No containers running**

**After Step 3 (Deploy Infra):**
- ✅ All above +
- ✅ Traefik running (reverse proxy)
- ✅ dns-manager running (DNS-01 challenges)
- ✅ Portainer running (Tailscale-only access)
- ✅ Docker networks created
- ❌ **No application services running**

**After Step 4 (Deploy All):**
- ✅ All services running
- ✅ Production ready

## Per-Service Deployment

Deploy individual services without affecting others:

```bash
make deploy-infra   # Traefik, dns-manager, Portainer
make deploy-auth    # Auth + PostgreSQL
make deploy-api     # API service
make deploy-ai      # AI service
make deploy-mcp     # MCP service
make deploy-all     # All app services (not infra)
```

## Safety Operations

### Create Snapshot (Backup)

```bash
make snapshot
```

Creates a VPS snapshot for recovery. **Note:** Creating a new snapshot overwrites the existing one.

### Verify Current Status

```bash
# Get VPS details
bash scripts/hostinger-api.sh get-details

# Check action status
bash scripts/hostinger-api.sh get-action <action_id>
```

## Troubleshooting

### If Bootstrap Fails

Ansible playbooks are **idempotent** - safe to re-run:

```bash
make config-vps VPS_IP=<ip>
```

### If Rebuild Gets Stuck

Check action status:

```bash
bash scripts/hostinger-api.sh get-action <action_id>
```

### Access Issues

If you can't SSH to VPS:
1. Verify Tailscale is connected on your Mac: `tailscale status`
2. Verify VPS joined Tailscale: Check Tailscale admin console
3. Try public IP temporarily (within first few minutes before SSH lockdown)

## Option B: GitHub Actions Rebuild

**Alternative method for remote execution or when local setup is unavailable.**

### When to Use GitHub Actions

- Remote execution (trigger from anywhere via GitHub web UI)
- CI/CD integration
- Full audit trail in GitHub Actions logs
- Team collaboration (anyone with repo access can trigger)
- Local machine is unavailable

### 4-Step Workflow

#### Step 1: VPS Recreate (~3-5 minutes)

**Trigger:** Manual - Actions → VPS Recreate → Type "RECREATE"

#### Step 2: Config VPS (~3-5 minutes)

**Trigger:** Auto-triggered after Step 1, or manual

#### Step 3: Deploy Infrastructure (~2-3 minutes)

**Trigger:** Manual - Actions → Deploy Infrastructure

#### Step 4: Deploy Services (~2-3 minutes)

**Trigger:** Manual or auto on push to main

## VPS Information

- **VPS ID**: 1264324
- **Template ID**: 1183 (AlmaLinux 10)
- **Current Public IP**: 76.13.26.69 (not for SSH - public SSH blocked)
- **Current Tailscale IP**: 100.108.199.106 (use this for SSH)
- **SSH Key**: `~/.ssh/remote.hill90.com`
- **Deploy User**: `deploy` (or `root` immediately after rebuild)

## Service Management Commands

```bash
# Restart services (on VPS via SSH)
make restart        # All services
make restart-api    # API only
make restart-traefik # Traefik only

# View logs (on VPS via SSH)
make ssh       # SSH to VPS
make logs      # All services
make logs-api  # API only
make logs-traefik  # Traefik only

# Health checks
make health    # Check all services
```

## Key Files

- `scripts/recreate-vps.sh` - Full rebuild automation
- `scripts/config-vps.sh` - Ansible bootstrap wrapper
- `scripts/deploy-infra.sh` - Infrastructure deployment
- `scripts/deploy-auth.sh` - Auth service deployment
- `scripts/deploy-api.sh` - API service deployment
- `scripts/deploy-ai.sh` - AI service deployment
- `scripts/deploy-mcp.sh` - MCP service deployment
- `scripts/deploy-all.sh` - All app services deployment
- `scripts/hostinger-api.sh` - VPS API operations
- `scripts/tailscale-api.sh` - Tailscale auth key generation
- `infra/ansible/playbooks/bootstrap.yml` - Master playbook
- `infra/ansible/playbooks/01-*.yml` through `08-*.yml` - Individual bootstrap stages

## Important Notes

1. **Destructive Operation**: `make recreate-vps` destroys all VPS data
2. **Always Snapshot**: Run `make snapshot` before rebuild (optional but recommended)
3. **Backup Cleanup**: Secrets backups auto-cleanup (keeps last 5)
4. **Zero Warnings**: Clean execution with no Ansible warnings
5. **Separated Deployment**: Ansible no longer deploys containers - use deploy scripts
6. **Per-Service Workflows**: Each service can be deployed independently
