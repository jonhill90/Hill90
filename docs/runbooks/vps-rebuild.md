# VPS Rebuild Runbook

Complete automated rebuild of the Hill90 VPS from catastrophic failure.

## Overview

The VPS rebuild is fully automated and requires **zero manual intervention**. The process takes ~8-13 minutes and consists of 3 steps:

1. **Recreate VPS** (~3-5 minutes) - OS rebuild via Hostinger API
2. **Config VPS** (~3-5 minutes) - Infrastructure bootstrap via Ansible
3. **Deploy** (~2-3 minutes) - Application service deployment

## Prerequisites

- **Local machine:** Repository cloned, all tools installed
- **Age key:** `infra/secrets/keys/age-prod.key` in repository
- **SSH key:** `~/.ssh/remote.hill90.com` configured
- **Secrets:** `infra/secrets/prod.enc.env` with VPS credentials

## Rebuild Workflow

### Step 0: Create Snapshot (Optional but Recommended)

Create a safety backup before destroying the VPS:

```bash
make snapshot
```

**Note:** Hostinger allows only 1 snapshot per VPS (overwrites existing).

---

### Step 1: Recreate VPS OS (~3-5 minutes)

Rebuild the VPS OS via Hostinger API:

```bash
make recreate-vps
```

**What happens automatically:**
1. Generates new Tailscale auth key via API (90-day expiry)
2. Updates `TAILSCALE_AUTH_KEY` in encrypted secrets
3. Generates random root password
4. Rebuilds VPS OS via Hostinger API (AlmaLinux 10)
5. Waits for rebuild completion (~135 seconds)
6. Retrieves new VPS public IP
7. Updates `VPS_IP` in encrypted secrets
8. Displays next command to run

**Result:**
- ✅ VPS OS rebuilt (AlmaLinux 10)
- ✅ New VPS IP captured in secrets
- ✅ New Tailscale auth key generated
- ❌ No services running yet

---

### Step 2: Bootstrap Infrastructure (~3-5 minutes)

Bootstrap infrastructure and deploy Traefik + Portainer:

```bash
make config-vps VPS_IP=<ip>
```

Use the VPS IP displayed by Step 1.

**What happens automatically:**
1. Runs Ansible bootstrap (9 playbooks)
   - Creates deploy user with SSH keys
   - Installs Docker and Docker Compose
   - Configures firewall (HTTP/HTTPS public, SSH Tailscale-only)
   - Installs Tailscale and joins network
   - Hardens SSH configuration
   - Installs SOPS and age for secrets
   - Clones repository to `/opt/hill90/app`
   - Transfers age encryption key
   - Deploys Traefik + Portainer (infrastructure only)
2. **Automatically updates DNS records** to new VPS IP
3. Extracts Tailscale IP from Ansible output
4. Updates `TAILSCALE_IP` in encrypted secrets

**Result:**
- ✅ Infrastructure ready (Docker, Tailscale, firewall)
- ✅ Traefik running (with DNS-01 certificates for Tailscale-only access)
- ✅ Portainer running (with DNS-01 certificates for Tailscale-only access)
- ✅ DNS records updated
- ✅ SSH locked to Tailscale network only
- ❌ Application services NOT running yet

**Infrastructure services deployed:**
- `traefik.hill90.com` - Traefik dashboard (Tailscale-only, authenticated)
- `portainer.hill90.com` - Portainer UI (Tailscale-only)
- `dns-manager` - DNS-01 challenge webhook (internal)

---

### Step 3: Deploy Application Services (~2-3 minutes)

Deploy application services with Let's Encrypt certificates:

```bash
# Option A: Staging certificates (safe for testing, unlimited)
make deploy

# Option B: Production certificates (rate-limited: 50/week)
make deploy-production
```

**What happens automatically:**
1. Validates infrastructure configuration
2. Decrypts secrets with SOPS
3. Generates Traefik `.htpasswd` file for authentication
4. Deploys application services (api, ai, mcp, auth, ui)
5. Requests Let's Encrypt certificates (staging or production)
6. Waits for services to start
7. Verifies service health

**Application services deployed:**
- `api.hill90.com` - API Gateway
- `ai.hill90.com` - LangChain/LangGraph agents
- `ai.hill90.com/mcp` - MCP Gateway (authenticated)
- `hill90.com` - Frontend UI
- `auth` - JWT authentication (internal)
- `postgres` - PostgreSQL database (internal)

**Result:**
- ✅ All services running
- ✅ Let's Encrypt certificates active
- ✅ Health checks passing

---

### Step 4: Health Verification

Verify all services are healthy:

```bash
make health
```

**Checks performed:**
- ✅ All Docker containers running
- ✅ Traefik dashboard accessible (https://traefik.hill90.com via Tailscale)
- ✅ Portainer accessible (https://portainer.hill90.com via Tailscale)
- ✅ API service responding (https://api.hill90.com/health)
- ✅ AI service responding (https://ai.hill90.com/health)
- ✅ DNS resolution correct for all domains
- ✅ SSL certificates valid

---

## Post-Rebuild Tasks

### 1. DNS Records (Automatically Updated)

DNS records are **automatically updated** during Step 2 (config-vps).

**Automatic updates:**
- `@` (hill90.com) → A record to new VPS IP
- `api.hill90.com` → A record to new VPS IP
- `ai.hill90.com` → A record to new VPS IP
- `portainer.hill90.com` → A record to new Tailscale IP
- `traefik.hill90.com` → A record to new Tailscale IP

**Verification:**
```bash
make dns-verify

# Or manually:
dig +short api.hill90.com
dig +short ai.hill90.com
dig +short hill90.com
dig +short portainer.hill90.com  # Tailscale IP
dig +short traefik.hill90.com    # Tailscale IP
```

### 2. Verify Tailscale Connection

Check Tailscale status on VPS:
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@100.68.116.66 'tailscale status'
# Should show: VPS online with Tailscale IP
```

Check local Tailscale connection:
```bash
tailscale status
# Should show VPS (hill90-vps) online
```

### 3. Verify SSH Access

**Test SSH via Tailscale (should SUCCEED):**
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@100.68.116.66
```

**Test SSH via public IP (should FAIL):**
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@76.13.26.69
# Connection refused - firewall blocks SSH from public internet
```

Firewall is configured during bootstrap to only allow SSH from Tailscale network (100.64.0.0/10).

---

## Rollback Procedures

### Restore from Snapshot

If rebuild fails catastrophically, restore from the snapshot created in Step 0:

1. Login to [Hostinger hPanel](https://hpanel.hostinger.com/)
2. Navigate to VPS section → Your VPS
3. Go to **Snapshots** tab
4. Click **Restore** on the snapshot
5. Confirm restoration
6. Wait ~5 minutes for restoration to complete

**Note:** Snapshot restoration is a destructive operation that wipes all current VPS data.

### Manual Recovery via Hostinger API

If you need to restore via API:

```bash
# List available snapshots
bash scripts/hostinger-api.sh get-snapshots

# Restore from snapshot (if snapshot exists)
bash scripts/hostinger-api.sh restore-snapshot <snapshot_id>
```

---

## Troubleshooting

### Bootstrap Fails

**Symptom:** Ansible bootstrap fails during playbook execution

**Resolution:**
1. Check SSH connectivity: `ssh root@<vps-ip>`
2. Review Ansible logs for specific error
3. Re-run bootstrap: `bash scripts/vps-bootstrap-from-rebuild.sh "$ROOT_PASSWORD" "$VPS_IP"`

### Deploy Fails

**Symptom:** `make deploy` fails

**Common causes:**
- Age key not transferred correctly
- Secrets decryption failure
- Docker image build failure

**Resolution:**
```bash
# Check age key
ssh deploy@<vps-ip> "ls -la /opt/hill90/secrets/keys/keys.txt"

# Test secrets decryption
sops -d infra/secrets/prod.enc.env

# Review deploy logs
ssh deploy@<vps-ip> "cd /opt/hill90/app && docker compose logs"
```

### DNS Not Updating

**Symptom:** Health checks show DNS mismatch

**Resolution:**
1. Wait 5-10 minutes for DNS propagation
2. Flush local DNS: `sudo dscacheutil -flushcache` (macOS)
3. Verify DNS provider records updated correctly

---

## Automation Summary

**Manual steps:**
1. (Optional) Create snapshot: `make snapshot`
2. Recreate VPS: `make recreate-vps`
3. Bootstrap infrastructure: `make config-vps VPS_IP=<ip>`
4. Deploy applications: `make deploy` or `make deploy-production`
5. Verify health: `make health`

**Fully automated (no intervention):**
- ✅ Tailscale auth key generation and rotation
- ✅ VPS OS rebuild via Hostinger API
- ✅ IP retrieval and secret updates
- ✅ User creation (deploy user with SSH keys)
- ✅ Docker installation
- ✅ Firewall configuration (HTTP/HTTPS public, SSH Tailscale-only)
- ✅ Tailscale network join
- ✅ SSH hardening (root login disabled, password auth disabled)
- ✅ SOPS and age installation
- ✅ Repository cloning to `/opt/hill90/app`
- ✅ Age key transfer
- ✅ **Infrastructure deployment (Traefik + Portainer)**
- ✅ **DNS record updates**
- ✅ Application deployment
- ✅ Let's Encrypt certificate acquisition (HTTP-01 + DNS-01)
- ✅ Health verification

**Total rebuild time:** ~8-13 minutes (3-5 min + 3-5 min + 2-3 min)

---

## Security Considerations

1. **Root password:** Generated randomly, used only during OS rebuild, never stored permanently
2. **SSH access:** Locked to Tailscale network only (100.64.0.0/10) after bootstrap completes
3. **Firewall:** HTTP/HTTPS public, SSH from Tailscale network only (configured via firewalld)
4. **Secrets:** Encrypted with SOPS + age, decrypted only on VPS during deployment
5. **SSL/TLS:** Automatic via Traefik + Let's Encrypt
   - HTTP-01 challenge for public services (api, ai, mcp, ui)
   - DNS-01 challenge for Tailscale-only services (traefik, portainer)
6. **Traefik authentication:** Password hash auto-generated from encrypted secrets, bcrypt format
7. **IP whitelisting:** Tailscale services protected by IP whitelist middleware (100.64.0.0/10)
8. **Tailscale key rotation:** New auth key generated on every rebuild (90-day expiry)

---

## Related Documentation

- [Bootstrap Runbook](bootstrap.md)
- [Claude Code Operating Manual](../../CLAUDE.md)
- [Health Check Script](../../scripts/health-check.sh)
