# VPS Bootstrap Runbook

Guide for bootstrapping a fresh Hill90 VPS infrastructure.

## Overview

VPS bootstrap is fully automated via Ansible and takes ~3-5 minutes. It's executed as **Step 2** of the [VPS Rebuild workflow](./vps-rebuild.md).

## Bootstrap Process

### Automated via Makefile

```bash
make config-vps VPS_IP=<ip>
```

This single command:
1. Runs all 9 Ansible playbooks
2. Deploys infrastructure services (Traefik + Portainer)
3. Updates DNS records automatically
4. Captures Tailscale IP and updates secrets

### What Happens Automatically

**9 Ansible Playbooks Execute Sequentially:**

1. **01-system.yml** - System Setup
   - Creates deploy user with sudo privileges
   - Sets up SSH keys from `~/.ssh/remote.hill90.com.pub`
   - Creates directories (`/opt/hill90/app`, `/opt/hill90/secrets`)
   - Configures passwordless sudo for deploy user

2. **02-firewall.yml** - Firewall Configuration
   - Installs and enables firewalld
   - Opens HTTP (80/tcp) and HTTPS (443/tcp) for public access
   - Blocks SSH (22/tcp) from public internet
   - Configures rich rules for Tailscale SSH access (100.64.0.0/10)

3. **03-tailscale.yml** - Tailscale VPN
   - Installs Tailscale from official repository
   - Joins Tailscale network using auth key from secrets
   - Tags VPS as `tag:vps` for ACL management
   - Enables Tailscale on boot

4. **04-ssh-lockdown.yml** - SSH Hardening
   - Disables root login
   - Disables password authentication
   - Enforces key-based authentication only
   - Configures SSH to accept connections only from Tailscale network
   - Restarts sshd service

5. **05-docker.yml** - Docker Installation
   - Installs Docker Engine (latest stable)
   - Installs Docker Compose v2
   - Adds deploy user to docker group
   - Enables Docker on boot
   - Configures Docker daemon settings

6. **06-sops.yml** - Secrets Management
   - Installs SOPS (latest release)
   - Installs age encryption tool (latest release)
   - Configures SOPS environment variables

7. **07-repo.yml** - Repository Clone
   - Clones Hill90 repository to `/opt/hill90/app`
   - Sets deploy user as owner
   - Configures git safe directory

8. **08-secrets-transfer.yml** - Encryption Key Transfer
   - Copies age key from local machine to VPS
   - Saves to `/opt/hill90/secrets/keys/keys.txt`
   - Sets secure permissions (600, deploy user)
   - Creates symlink in repository for compatibility

9. **09-deploy-infrastructure.yml** - Infrastructure Deployment
   - Deploys Traefik edge proxy (with DNS-01 certificates)
   - Deploys Portainer container management UI
   - Deploys dns-manager service (for DNS-01 challenges)
   - Verifies all containers start successfully

**Post-Ansible Automation:**
- Extracts Tailscale IP from Ansible output
- Updates `TAILSCALE_IP` in encrypted secrets
- **Automatically updates DNS records** via Hostinger API
- Displays infrastructure summary

## Infrastructure After Bootstrap

✅ **Infrastructure services running:**
- Docker Engine + Compose v2
- Tailscale VPN connected
- Traefik reverse proxy (https://traefik.hill90.com, Tailscale-only)
- Portainer UI (https://portainer.hill90.com, Tailscale-only)
- dns-manager (internal service for DNS-01 challenges)

✅ **System configuration:**
- deploy user with sudo access
- Firewall configured (HTTP/HTTPS public, SSH Tailscale-only)
- SSH hardened (no root, no passwords, key-only)
- Repository cloned to `/opt/hill90/app`
- Age encryption key transferred
- DNS records updated to new VPS IP

❌ **Application services NOT running:**
- API, AI, MCP, Auth, UI services require deployment (Step 3)

## Next Steps

After bootstrap completes, deploy application services:

```bash
# Option A: Staging certificates (safe for testing, unlimited)
make deploy

# Option B: Production certificates (rate-limited: 50/week)
make deploy-production

# Verify health
make health
```

## Manual Steps (If Needed)

### 1. Initialize Secrets (First Time Only)

If starting from scratch without existing secrets:

```bash
make secrets-init
```

This creates:
- Age keypair (`infra/secrets/keys/age-prod.key` and `.pub`)
- Encrypted secrets file (`infra/secrets/prod.enc.env`)

### 2. Configure Secrets

Edit secrets to fill in required values:

```bash
make secrets-edit
```

**Required secrets:**
- `VPS_IP` - VPS public IP (auto-updated during rebuild)
- `TAILSCALE_IP` - Tailscale VPN IP (auto-updated during bootstrap)
- `TAILSCALE_AUTH_KEY` - Tailscale auth key (auto-generated during rebuild)
- `HOSTINGER_API_KEY` - Hostinger DNS/VPS API key
- `TRAEFIK_ADMIN_PASSWORD_HASH` - bcrypt hash for Traefik dashboard
- Database credentials, API keys, etc.

### 3. Configure DNS (First Time Only)

On first setup, point these domains to your VPS:

**Public services (VPS public IP):**
- `@` (hill90.com)
- `api.hill90.com`
- `ai.hill90.com`

**Tailscale-only services (Tailscale IP):**
- `traefik.hill90.com`
- `portainer.hill90.com`

**Note:** After initial setup, DNS is automatically updated during VPS rebuilds.

## Verification

### Check SSH Access

```bash
# Should SUCCEED via Tailscale
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>

# Should FAIL via public IP (expected - SSH is blocked)
ssh -i ~/.ssh/remote.hill90.com deploy@<public-ip>
```

### Check Docker

```bash
ssh deploy@<tailscale-ip> 'docker --version'
ssh deploy@<tailscale-ip> 'docker compose version'
```

### Check Infrastructure Services

```bash
ssh deploy@<tailscale-ip> 'docker ps'
# Should show: traefik, portainer, dns-manager
```

### Check Tailscale

```bash
ssh deploy@<tailscale-ip> 'tailscale status'
```

### Check Firewall

```bash
ssh deploy@<tailscale-ip> 'sudo firewall-cmd --list-all'
# Should show:
# - services: http https
# - rich rules for SSH from 100.64.0.0/10
```

## Troubleshooting

### Bootstrap Fails

**Ansible playbooks are idempotent** - safe to re-run:

```bash
make config-vps VPS_IP=<ip>
```

### SSH Access Issues

See [Troubleshooting Guide](./troubleshooting.md#vps-access-issues)

### Tailscale Connection Issues

1. Check auth key is valid:
   ```bash
   make secrets-view KEY=TAILSCALE_AUTH_KEY
   ```

2. Generate new auth key if expired:
   ```bash
   make tailscale-rotate
   ```

3. Verify VPS joined Tailscale:
   - Login to Tailscale admin console
   - Check devices list for VPS hostname

### Infrastructure Services Not Starting

1. Check Docker logs:
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs traefik'
   ssh deploy@<tailscale-ip> 'docker logs portainer'
   ```

2. Verify secrets decryption:
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && \
     export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && \
     sops -d infra/secrets/prod.enc.env | head -5'
   ```

## Related Documentation

- [VPS Rebuild Runbook](./vps-rebuild.md) - Complete rebuild workflow
- [Troubleshooting Guide](./troubleshooting.md) - Common issues and solutions
- [Architecture Overview](../architecture/overview.md) - System architecture
- [Certificate Management](../architecture/certificates.md) - HTTP-01 vs DNS-01 challenges
