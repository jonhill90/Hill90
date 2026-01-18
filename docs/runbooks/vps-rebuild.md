# VPS Rebuild Runbook

Complete automated rebuild of the Hill90 VPS from catastrophic failure.

## Prerequisites

- **Local machine:** Repository cloned, all tools installed
- **Terraform state:** `infra/terraform/hostinger/terraform.tfstate` exists
- **Age key:** Local age key at `~/.config/sops/age/keys.txt`
- **SSH key:** `~/.ssh/remote.hill90.com` configured
- **Claude Code:** Access to MCP tools for VPS management

## Rebuild Workflow

### Step 1: Create Snapshot (Safety Net)

Claude Code executes via MCP:
```
mcp__MCP_DOCKER__VPS_createSnapshotV1(virtualMachineId=<VPS_ID>)
```

**Note:** Hostinger allows only 1 snapshot per VPS (overwrites existing)

**Automated alternative:**
```bash
# If configured in scripts
make snapshot
```

---

### Step 2: OS Rebuild (DESTRUCTIVE)

Claude Code executes:

1. Generate secure root password:
```bash
ROOT_PASSWORD=$(openssl rand -base64 32)
```

2. Get VPS details from Terraform:
```bash
cd infra/terraform/hostinger
VPS_ID=$(terraform output -raw vps_id)
TEMPLATE_ID=$(terraform output -raw template_id)  # AlmaLinux 10
```

3. Rebuild OS via MCP:
```
mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1(
  virtualMachineId=$VPS_ID,
  template_id=$TEMPLATE_ID,
  password=$ROOT_PASSWORD
)
```

**Result:**
- All VPS data wiped
- AlmaLinux 10 fresh install
- Snapshots deleted
- VPS offline ~5 minutes
- New root password set

---

### Step 3: Bootstrap VPS

Claude Code executes after rebuild completes:

```bash
# Get new VPS IP from MCP response or Hostinger panel
NEW_VPS_IP="<ip_from_rebuild>"

# Run automated bootstrap
bash scripts/vps-bootstrap-from-rebuild.sh "$ROOT_PASSWORD" "$NEW_VPS_IP"
```

**What this script does automatically:**

1. **Remove old SSH host key**
   ```bash
   ssh-keygen -R "$NEW_VPS_IP"
   ```

2. **Update Ansible inventory**
   - Updates `infra/ansible/inventory/hosts.yml` with new IP
   - Backs up old inventory to `.bak` file

3. **Update encrypted secrets**
   - Decrypts `infra/secrets/prod.enc.env`
   - Updates `VPS_IP` variable
   - Re-encrypts and saves

4. **Run Ansible bootstrap playbook**
   - Creates deploy user with SSH keys
   - Installs Docker and Docker Compose
   - Configures firewall (HTTP/HTTPS public, SSH from Docker only)
   - Hardens SSH configuration
   - Installs SOPS and age for secrets
   - **Installs git**
   - **Clones Hill90 repository to `/opt/hill90/app`**

5. **Transfer age encryption key**
   - SCPs local age key to VPS
   - Sets correct permissions (600)
   - VPS can now decrypt secrets

**Bootstrap output:**
```
========================================
Bootstrap Complete!
========================================

Next steps:
  1. Deploy application: make deploy
  2. Verify health: make health
  3. Update DNS records if IP changed
```

---

### Step 4: Deploy Services

Claude Code executes:

```bash
make deploy
```

**What this does:**
1. SSHs to VPS
2. Navigates to `/opt/hill90/app`
3. Decrypts secrets locally
4. Builds custom Docker images (auth, api, ai, mcp)
5. Pulls external images (traefik, postgres, twingate)
6. Starts all services via Docker Compose
7. Verifies all containers running

**Services deployed:**
- traefik (edge proxy)
- api (TypeScript API)
- ai (Python AI service)
- mcp (TypeScript MCP service)
- auth (TypeScript auth service)
- postgres (PostgreSQL database)
- twingate (zero-trust connector)

---

### Step 5: Health Verification

Claude Code executes:

```bash
make health
```

**Checks performed:**
- ✅ All Docker containers running
- ✅ Traefik dashboard accessible
- ✅ API service responding (https://api.hill90.com/health)
- ✅ AI service responding (https://ai.hill90.com/health)
- ✅ DNS resolution correct for all domains
- ✅ SSL certificates valid

---

## Post-Rebuild Tasks

### 1. Update DNS (if IP changed)

**Domains to update:**
- `api.hill90.com` → A record to new VPS IP
- `ai.hill90.com` → A record to new VPS IP
- `hill90.com` → A record to new VPS IP

**Verification:**
```bash
dig +short api.hill90.com
dig +short ai.hill90.com
dig +short hill90.com
```

### 2. Verify Twingate Connector

Check connector status:
```bash
ssh deploy@<vps-ip>
docker logs twingate
# Should show: State: Online
```

Verify Twingate admin console shows connector online.

### 3. Test Twingate SSH Access

```bash
# Via Twingate client
ssh -i ~/.ssh/remote.hill90.com deploy@172.18.0.1
```

Should work through Twingate tunnel.

### 4. Lock Down Public SSH (After Twingate Verified)

**CRITICAL:** Only do this AFTER confirming Twingate SSH works!

```bash
ssh deploy@<vps-ip>
sudo firewall-cmd --remove-service=ssh --permanent
sudo firewall-cmd --reload
```

**Verify:**
```bash
# From public internet (should FAIL)
ssh deploy@<vps-ip>
# Connection refused or timeout

# Via Twingate (should SUCCEED)
ssh -i ~/.ssh/remote.hill90.com deploy@172.18.0.1
```

---

## Rollback Procedures

### Restore from Snapshot

If rebuild fails catastrophically:

Claude Code executes via MCP:
```
mcp__MCP_DOCKER__VPS_restoreSnapshotV1(virtualMachineId=$VPS_ID)
```

VPS will revert to pre-rebuild state.

### Manual Recovery via Hostinger Console

If MCP tools unavailable:

1. Login to [Hostinger hPanel](https://hpanel.hostinger.com/)
2. Navigate to VPS section
3. Access VNC console
4. Manually rebuild or restore snapshot

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

**Manual steps (Claude Code):**
1. Create snapshot via MCP
2. Rebuild OS via MCP (with generated password)
3. Run bootstrap script with new IP

**Fully automated (no intervention):**
- ✅ Inventory updates
- ✅ Secrets updates
- ✅ User creation
- ✅ Docker installation
- ✅ Firewall configuration
- ✅ SSH hardening
- ✅ Git installation
- ✅ Repository cloning
- ✅ Age key transfer
- ✅ Service deployment
- ✅ Health verification

**Total rebuild time:** ~10 minutes (5 min rebuild + 5 min bootstrap/deploy)

---

## Security Considerations

1. **Root password:** Generated randomly, stored temporarily in `/tmp/hill90_root_password.txt`, deleted after bootstrap
2. **SSH access:** Initially public during rebuild, locked to Twingate after verification
3. **Firewall:** HTTP/HTTPS public, SSH from Docker networks only (Twingate connector)
4. **Secrets:** Encrypted with age, decrypted only on VPS during deployment
5. **SSL:** Automatic via Traefik + Let's Encrypt

---

## Related Documentation

- [Bootstrap Runbook](bootstrap.md)
- [Twingate Access Guide](../TWINGATE_ACCESS.md)
- [Claude Code Operating Manual](../../CLAUDE.md)
- [Health Check Script](../../scripts/health-check.sh)
