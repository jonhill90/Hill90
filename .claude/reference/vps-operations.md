# VPS Operations Reference

## VPS Rebuild Options

The VPS rebuild is fully automated with **zero manual intervention** required.

Two rebuild options are available:

- **Option A: Local Execution (Recommended)** - Faster, simpler, no GitHub UI needed
- **Option B: GitHub Actions** - Remote execution, full audit trail, accessible from anywhere

Both options use the same underlying automation and produce identical results.

## Option A: Local Rebuild (Recommended)

**Preferred method for speed and simplicity.**

### Complete Rebuild Workflow (3 Steps)

```bash
# Step 1: Rebuild VPS OS (auto-waits, auto-retrieves IP, auto-updates secrets)
make recreate-vps

# Step 2: Bootstrap infrastructure (auto-extracts Tailscale IP, auto-updates secrets, deploys Traefik + Portainer)
make config-vps VPS_IP=<ip>

# Step 3: Deploy application services
make deploy  # Staging certificates (safe for testing)
# OR
make deploy-production  # Production certificates (rate-limited!)
```

**Total time:** ~8-13 minutes (3-5 min + 3-5 min + 2-3 min)

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
1. Runs Ansible bootstrap (9 stages)
   - System setup (deploy user, directories)
   - Firewall configuration
   - Tailscale installation and join
   - SSH lockdown (Tailscale-only access)
   - Docker installation
   - SOPS and age installation
   - Repository clone
   - Secrets transfer
2. **Deploys Traefik + Portainer (infrastructure only)**
3. **Automatically updates DNS records** to new VPS IP
4. **Extracts Tailscale IP from Ansible output**
5. **Updates TAILSCALE_IP secret automatically**
6. Displays infrastructure summary

**Step 3: `make deploy` or `make deploy-production`** (~2-3 minutes):
1. Validates infrastructure configuration
2. Decrypts secrets with SOPS
3. Generates Traefik .htpasswd file
4. Deploys application services (api, ai, mcp, auth, ui)
5. Requests Let's Encrypt certificates (staging or production)
6. Verifies service health

### Infrastructure After Step 2 (Config VPS)

✅ **Infrastructure services running:**
- Docker 29.1.5 + Compose v5.0.1
- SOPS 3.8.1 for secrets
- age 1.1.1 for encryption
- Tailscale connected
- **Traefik running** (with DNS-01 certificates for Tailscale-only access)
- **Portainer running** (with DNS-01 certificates for Tailscale-only access)
- Repository cloned to `/opt/hill90/app`
- Age key transferred to `/opt/hill90/secrets/keys/keys.txt`
- SSH locked to Tailscale network only (public SSH blocked)
- Firewall configured (HTTP/HTTPS public, SSH Tailscale-only)
- **DNS records updated** to new VPS IP

❌ **Application services NOT running:**
- API, AI, MCP, Auth, UI services are NOT deployed yet
- Step 3 (deployment) required to start application services

### Step 3: Deploy Application Services

**After Step 2 completes, deploy application services:**

```bash
# Option A: Deploy with staging certificates (safe for testing, unlimited)
make deploy

# Option B: Deploy with production certificates (rate-limited: 50/week)
make deploy-production

# Verify health
make health

# SSH access (via Tailscale IP only)
make ssh
# or
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>
```

**GitHub Actions deployment:**
- Trigger "Deploy" workflow (uses production certificates by default)
- Auto-triggered on push to `main` branch

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

### 3-Step Workflow

**Complete VPS rebuild via GitHub Actions takes ~8-13 minutes:**

#### Step 1: VPS Recreate (~3-5 minutes)

**How to trigger:**
1. Go to repository → **Actions** → **VPS Recreate (Automated)**
2. Click **"Run workflow"**
3. Type **"RECREATE"** exactly in the confirmation input
4. Click **"Run workflow"** button

**What happens:**
1. Generates new Tailscale auth key via API
2. Rebuilds VPS OS via Hostinger API
3. Waits for rebuild completion
4. Retrieves new VPS IP
5. Updates VPS_IP secret
6. **Auto-triggers config-vps workflow**

#### Step 2: Config VPS (~3-5 minutes - Auto-triggered)

**Automatically triggered after Step 1 completes.**

**What happens:**
1. Runs Ansible bootstrap (9 stages)
2. Deploys Traefik + Portainer (infrastructure only)
3. **Automatically updates DNS records**
4. Extracts Tailscale IP
5. Updates TAILSCALE_IP secret
6. Commits updated secrets to repository

**After completion:**
- Infrastructure ready (Traefik + Portainer running)
- DNS records updated
- Application services NOT deployed yet

#### Step 3: Deploy Application (~2-3 minutes - Manual)

**How to trigger:**
1. Go to repository → **Actions** → **Deploy**
2. Click **"Run workflow"**
3. Click **"Run workflow"** button

**What happens:**
1. Validates infrastructure
2. Deploys application services (api, ai, mcp, auth, ui)
3. Uses production Let's Encrypt certificates
4. Runs health checks

**Auto-trigger:**
- Push to `main` branch (if files changed in `src/**`, `deployments/**`, `scripts/deploy.sh`)

### Requirements

- GitHub secrets configured (see `.claude/reference/github-actions.md`)
- Workflow files:
  - `.github/workflows/recreate-vps.yml` (Step 1)
  - `.github/workflows/config-vps.yml` (Step 2)
  - `.github/workflows/deploy.yml` (Step 3)

**Full documentation:** See `.claude/reference/github-actions.md`

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
- `scripts/hostinger-api.sh` - VPS API operations
- `scripts/tailscale-api.sh` - Tailscale auth key generation
- `infra/ansible/playbooks/bootstrap.yml` - Master playbook
- `infra/ansible/playbooks/01-*.yml` through `09-*.yml` - Individual bootstrap stages

## Important Notes

1. **Destructive Operation**: `make recreate-vps` destroys all VPS data
2. **Always Snapshot**: Run `make snapshot` before rebuild (optional but recommended)
3. **Backup Cleanup**: Secrets backups auto-cleanup (keeps last 5)
4. **Zero Warnings**: Clean execution with no Ansible warnings
5. **Cross-Platform**: Works on macOS and Linux (BSD/GNU grep compatible)
6. **One-Shot Operations**: Both commands require single approval, no manual bash scripts
