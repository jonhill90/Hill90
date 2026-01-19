# VPS Operations Reference

## VPS Rebuild Options

The VPS rebuild is fully automated with **zero manual intervention** required.

Two rebuild options are available:

- **Option A: Local Execution (Recommended)** - Faster, simpler, no GitHub UI needed
- **Option B: GitHub Actions** - Remote execution, full audit trail, accessible from anywhere

Both options use the same underlying automation and produce identical results.

## Option A: Local Rebuild (Recommended)

**Preferred method for speed and simplicity.**

### Complete Rebuild Workflow

```bash
# 1. Rebuild VPS (auto-waits, auto-retrieves IP, auto-updates secrets)
make recreate-vps

# 2. Bootstrap infrastructure (auto-extracts Tailscale IP, auto-updates secrets)
make config-vps VPS_IP=<ip>
```

**Total time:** ~5-10 minutes

### What Happens Automatically

**`make recreate-vps`** (2-3 minutes):
1. Generates new Tailscale auth key via API
2. Updates TAILSCALE_AUTH_KEY secret
3. Generates random root password
4. Rebuilds VPS via Hostinger API
5. **Waits for rebuild to complete** (~135s)
6. **Retrieves new VPS IP automatically**
7. **Updates VPS_IP secret automatically**
8. Displays next command to run

**`make config-vps VPS_IP=<ip>`** (5-10 minutes):
1. Runs Ansible bootstrap (9 stages)
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
4. Displays infrastructure summary

### Infrastructure After Bootstrap

✅ **Ready for deployment:**
- Docker 29.1.5 + Compose v5.0.1
- SOPS 3.8.1 for secrets
- age 1.1.1 for encryption
- Tailscale connected
- Repository cloned to `/opt/hill90/app`
- Age key transferred to `/opt/hill90/secrets/keys/keys.txt`
- SSH locked to Tailscale network only (public SSH blocked)
- Firewall configured (HTTP/HTTPS public, SSH Tailscale-only)

### Next Steps After Bootstrap

```bash
# Deploy application
make deploy

# Verify health
make health

# SSH access (via Tailscale IP only)
make ssh
# or
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>
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

### How to Trigger

1. Go to repository → **Actions** → **VPS Recreate (Automated)**
2. Click **"Run workflow"**
3. Type **"RECREATE"** exactly in the confirmation input
4. Click **"Run workflow"** button
5. Watch execution in real-time

### Expected Timeline

- Setup: ~1 minute
- VPS recreate: ~5 minutes (rebuild + wait for SSH)
- Bootstrap: ~5 minutes (Ansible 9-stage setup)
- Deploy: ~2 minutes (all 6 services)
- Cleanup: ~30 seconds
- **Total:** ~13 minutes

### What Happens

1. Validates confirmation input ("RECREATE")
2. Sets up Tailscale, SSH keys, SOPS on runner
3. Runs `make recreate-vps` (generates keys, rebuilds VPS, updates secrets)
4. Waits for SSH availability on new VPS
5. Runs `make config-vps` (Ansible bootstrap)
6. Deploys services via SSH over Tailscale
7. Attempts to commit updated secrets to repository (may fail - non-blocking)
8. Cleans up backup files

### Requirements

- GitHub secrets configured (see `.claude/reference/github-actions.md`)
- Workflow file: `.github/workflows/recreate-vps.yml`

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
