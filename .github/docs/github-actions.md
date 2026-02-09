# GitHub Actions Automation Reference

## Overview

**Hybrid approach:** Both Mac-based (local scripts) and GitHub Actions automation are available.

- ✅ **Mac/Local:** Use `make recreate-vps` + `make config-vps` (API-based, fully automated)
- ✅ **GitHub Actions:** Full automation via Hostinger API (tested and operational)

## Workflow Status & Test Results

### VPS Recreate Workflow - ✅ INFRASTRUCTURE ONLY

**Last tested:** January 19, 2026 (with deployment)
**Status:** Infrastructure bootstrap operational

**What it does:**
- ✅ VPS recreate via Hostinger API
- ✅ Automatic wait for SSH availability
- ✅ Bootstrap via Ansible (all 9 stages)
- ✅ New VPS IPs captured automatically
- ⚠️ **DOES NOT deploy services** (prevents Let's Encrypt rate limit issues)

**After recreate:**
- Infrastructure ready but services NOT running
- Manually trigger staging or production deployment workflow
- This separation allows unlimited VPS rebuild testing without using certificate quota

**Expected behavior (non-blocking):**
- Git commit/push may fail if running locally (permissions - can be ignored)
- Secrets are updated locally regardless of git push status

**Current VPS (from successful test):**
- Public IP: 76.13.26.69 (SSH blocked by firewall)
- Tailscale IP: 100.108.199.106 (use for SSH access)
- Hostname: srv1264324.hstgr.cloud

### Config VPS Workflow - ✅ INFRASTRUCTURE BOOTSTRAP

**Workflow file:** `.github/workflows/config-vps.yml`

**Status:** Operational

**Triggers:**
- Automatic after recreate-vps workflow completes
- Manual workflow dispatch

**What it does:**
- Infrastructure bootstrap via Ansible
- Traefik + Portainer deployment (infrastructure only)
- Tailscale IP extraction and secret updates
- **Automatic DNS record updates** ✨

**Duration:** ~3-5 minutes

**Note:** Application services are NOT deployed. Use Deploy workflow after this completes.

### Deploy Workflow - ✅ PRODUCTION CERTIFICATES BY DEFAULT

**Workflow file:** `.github/workflows/deploy.yml`

**Status:** Operational (consolidated single workflow)

**Triggers:**
- Push to `main` branch (auto)
- Manual workflow dispatch

**Certificates:**
- Let's Encrypt PRODUCTION environment by default
- Trusted by all browsers
- **Rate limits:** 50 certificates/week, 5 failures/hour

**What it does:**
- Deploys application services (api, ai, mcp, auth, ui)
- Uses production Let's Encrypt certificates
- Validates infrastructure before deployment
- Health check validation

**Duration:** ~2-3 minutes

**Certificate Management:**
- Production certificates by default (workflow uses PRODUCTION ACME server)
- For staging certificates during local development, use `make deploy` (uses STAGING ACME server)
- Separation between local (staging) and CI/CD (production) certificates

### Tailscale ACL GitOps Workflow - ✅ OPERATIONAL

**Workflow file:** `.github/workflows/tailscale.yml`

**Status:** Automatic ACL deployment implemented

**How it works:**
- Push to main → ACL automatically deployed to Tailscale
- Pull request → ACL tested for validity
- Policy source: `policy.hujson` in repository root
- Manages SSH access rules, tag ownership, and network grants

**Key features:**
- Admin SSH access via `autogroup:admin` → `tag:vps`
- GitHub Actions runners access via `tag:github-actions` → `tag:vps`
- Changes tracked in git with full audit trail

## Current Local Workflow (Mac)

```bash
# 2-command rebuild (API-based, fully automated)
make recreate-vps                      # Rebuild via Hostinger API
make config-vps VPS_IP=<ip>            # Bootstrap with Ansible
```

**No MCP tools needed** - Uses Hostinger API and Tailscale API directly.

## Available GitHub Actions Workflows

### 1. VPS Recreate Workflow

**`.github/workflows/recreate-vps.yml`** - VPS OS Rebuild
- **Trigger:** Manual only (`workflow_dispatch`)
- **Confirmation:** Type "RECREATE" to confirm destructive operation
- **Features:**
  - Generates new Tailscale auth key via API
  - Rebuilds VPS OS via Hostinger API
  - Waits for rebuild completion
  - Retrieves new VPS IP automatically
  - Updates VPS_IP secret
  - Auto-triggers config-vps workflow
- **Duration:** ~3-5 minutes
- **Status:** ✅ Operational

**After completion:**
- VPS OS rebuilt (AlmaLinux 10)
- New VPS IP captured in secrets
- Auto-triggers config-vps workflow

### 2. Config VPS Workflow

**`.github/workflows/config-vps.yml`** - Infrastructure Bootstrap
- **Trigger:** Automatic after recreate-vps, or manual dispatch
- **Features:**
  - Infrastructure bootstrap via Ansible (9 stages)
  - Deploys Traefik + Portainer (infrastructure only)
  - Extracts Tailscale IP from Ansible output
  - Updates TAILSCALE_IP secret
  - **Automatically updates DNS records** ✨
  - Commits updated secrets to repository
- **Duration:** ~3-5 minutes
- **Status:** ✅ Operational

**After completion:**
- Infrastructure ready (Docker, Tailscale, firewall)
- Traefik + Portainer running (with DNS-01 certificates)
- Application services NOT deployed
- DNS records updated to new VPS IP

### 3. Deploy Workflow

**`.github/workflows/deploy.yml`** - Application Deployment
- **Trigger:** Push to `main` branch (auto), manual dispatch
- **Certificates:** Let's Encrypt PRODUCTION (trusted, rate-limited: 50/week)
- **Features:**
  - Validates infrastructure before deployment
  - Deploys application services (api, ai, mcp, auth, ui)
  - Uses production Let's Encrypt certificates
  - Health check validation
  - Deploys via SSH over Tailscale
- **Duration:** ~2-3 minutes
- **Status:** ✅ Operational

**Certificate Note:**
- GitHub Actions uses PRODUCTION certificates by default
- Local `make deploy` uses STAGING certificates by default
- Use `make deploy-production` locally for production certificates

### 4. Tailscale ACL GitOps Workflow

**`.github/workflows/tailscale.yml`** - Network Access Control
- **Trigger:** Automatic on push to main (for `policy.hujson` changes)
- **Features:**
  - Automatic ACL deployment to Tailscale network
  - ACL validation on pull requests
  - Full audit trail in git
  - Manages SSH access, tags, and network grants
- **Status:** ✅ Operational

## Required GitHub Secrets Setup

Before using GitHub Actions workflows, you must add the following secrets to your repository.

### How to Add Secrets to GitHub

1. Go to repository → **Settings** → **Secrets and variables** → **Actions** → **Secrets**
2. Click **"New repository secret"**
3. Enter the **Name** and **Value**
4. Click **"Add secret"**

### 1. HOSTINGER_API_KEY

**What it's for:** VPS management API access (recreate, get details, snapshots)

**How to obtain:**
1. Login to Hostinger control panel: https://hpanel.hostinger.com
2. Navigate to: **Profile** → **API Settings** (or directly: https://hpanel.hostinger.com/api)
3. Click **"Create API Key"** or **"Generate New Key"**
4. Copy the API key (starts with `hpanel_` or similar)
5. **IMPORTANT:** Save it immediately - you cannot view it again after leaving the page

**To add to GitHub:**
- Name: `HOSTINGER_API_KEY`
- Value: Paste the API key

**Quick verification (local test):**
```bash
export HOSTINGER_API_KEY="your-key-here"
bash scripts/hostinger-api.sh get-details
```

---

### 2. TAILSCALE_API_KEY

**What it's for:** Tailscale device and auth key management API

**How to obtain:**
1. Login to Tailscale admin console: https://login.tailscale.com/admin/settings/keys
2. Click **"Generate access token"** or **"Create access token"**
3. **Important:** Select these permissions:
   - ✅ **Devices: Write**
   - ✅ **Auth keys: Read & Write**
4. Set expiration: 90 days or longer (recommendation: 1 year for stability)
5. Optional: Add description "Hill90 GitHub Actions"
6. Click **"Generate token"**
7. Copy the token (starts with `tskey-api-`)

**To add to GitHub:**
- Name: `TAILSCALE_API_KEY`
- Value: Paste the token

**Quick verification (local test):**
```bash
export TAILSCALE_API_KEY="your-key-here"
bash scripts/tailscale-api.sh generate-key
```

---

### 3. TS_OAUTH_CLIENT_ID & TS_OAUTH_SECRET

**What they're for:** Allow GitHub Actions runners to join your Tailscale network as ephemeral nodes for SSH access to VPS.

**Prerequisites:**
- You must have **Owner**, **Admin**, or **Network admin** permissions in Tailscale
- You must have at least one tag configured (we use `tag:ci`)

**How to create a tag (if you don't have one):**
1. Login to Tailscale admin console: https://login.tailscale.com/admin/acls/file
2. Add this to your ACL file under `tagOwners`:
   ```json
   "tagOwners": {
     "tag:ci": ["autogroup:admin"]
   }
   ```
3. Click **"Save"**

**How to obtain OAuth credentials:**
1. Login to Tailscale admin console: https://login.tailscale.com/admin/settings/oauth
2. Click **"Generate OAuth Client"** or **"Add OAuth Client"**
3. Configure the OAuth client:
   - **Description:** "Hill90 GitHub Actions Runner"
   - **OAuth client scopes:**
     - ✅ `auth_keys` (this is the required scope for GitHub Actions)
   - Click **"Generate client"**
4. Copy **Client ID** (starts with `client_`)
5. Copy **Client secret** (starts with similar prefix)
6. **IMPORTANT:** Save both immediately - you cannot view the secret again

**To add to GitHub:**

**First secret:**
- Name: `TS_OAUTH_CLIENT_ID`
- Value: Paste the Client ID

**Second secret:**
- Name: `TS_OAUTH_SECRET`
- Value: Paste the Client secret

**How it works:**
- The Tailscale GitHub Action creates **ephemeral nodes** that are automatically cleaned up after workflow completion
- These ephemeral nodes are **pre-approved** on tailnets that use device approval
- The runner can then SSH to your VPS via the Tailscale network

**Note:** This is separate from `TAILSCALE_API_KEY`. The API key is for managing devices/keys via API, while OAuth is for authenticating GitHub runners to join the network as ephemeral nodes.

**Official documentation:** https://tailscale.com/kb/1276/tailscale-github-action

---

### 4. VPS_SSH_PRIVATE_KEY

**What it's for:** SSH access to VPS from GitHub Actions runners

**How to obtain:**

This is your existing SSH private key used to access the VPS.

1. On your Mac, read the private key:
   ```bash
   cat ~/.ssh/remote.hill90.com
   ```
2. Copy the **entire output** (including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`)

**To add to GitHub:**
- Name: `VPS_SSH_PRIVATE_KEY`
- Value: Paste the entire private key

**Security note:** This key will only be accessible to GitHub Actions workflows in this repository. GitHub encrypts secrets at rest.

---

### 5. SOPS_AGE_KEY

**What it's for:** Decrypting SOPS-encrypted secrets on GitHub Actions runners

**How to obtain:**

This is your age private key used to decrypt SOPS-encrypted secrets.

1. On your Mac, read the age key:
   ```bash
   cat infra/secrets/keys/age-prod.key
   ```
2. Copy the **entire output** (starts with `# created: ...` and contains `AGE-SECRET-KEY-...`)

**To add to GitHub:**
- Name: `SOPS_AGE_KEY`
- Value: Paste the entire key file contents

**Quick verification (local test):**
```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key
sops -d infra/secrets/prod.enc.env
```

---

## GitHub Secrets Summary Checklist

After setup, you should have these **5 secrets** configured:

- [ ] `HOSTINGER_API_KEY` - VPS management API
- [ ] `TAILSCALE_API_KEY` - Device/key management API
- [ ] `TS_OAUTH_CLIENT_ID` - GitHub runner network access (ephemeral nodes)
- [ ] `TS_OAUTH_SECRET` - GitHub runner network access (ephemeral nodes)
- [ ] `VPS_SSH_PRIVATE_KEY` - SSH access to VPS
- [ ] `SOPS_AGE_KEY` - Secrets decryption

**To verify all secrets are configured:**
1. Go to repository → **Settings** → **Secrets and variables** → **Actions** → **Secrets**
2. You should see all 5 secrets listed:
   - HOSTINGER_API_KEY
   - TAILSCALE_API_KEY
   - TS_OAUTH_CLIENT_ID
   - TS_OAUTH_SECRET
   - VPS_SSH_PRIVATE_KEY
   - SOPS_AGE_KEY
3. Secrets will show when they were last updated, but values are hidden

---

## Using GitHub Actions Workflows

### Complete Rebuild Workflow (3 Steps)

**Full VPS rebuild takes ~8-13 minutes across 3 automated workflows:**

#### Step 1: VPS Recreate (~3-5 minutes)

**When to use:**
- Rebuild VPS OS from scratch (destructive operation)
- Catastrophic failure recovery

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
6. Auto-triggers config-vps workflow

**After completion:**
- VPS OS rebuilt (AlmaLinux 10)
- Config VPS workflow automatically triggered

#### Step 2: Config VPS (~3-5 minutes - Auto-triggered)

**Automatically triggered after recreate-vps completes.**

**What happens:**
1. Infrastructure bootstrap via Ansible (9 stages)
2. Deploys Traefik + Portainer (infrastructure only)
3. Extracts Tailscale IP from Ansible output
4. Updates TAILSCALE_IP secret
5. **Automatically updates DNS records** to new VPS IP
6. Commits updated secrets to repository

**After completion:**
- Infrastructure ready (Docker, Tailscale, firewall)
- Traefik + Portainer running with DNS-01 certificates
- DNS records updated
- Application services NOT deployed yet

#### Step 3: Deploy Application (~2-3 minutes - Manual)

**When to use:**
- After VPS rebuild (Step 2) completes
- Application code changes
- Configuration updates

**How to trigger manually:**
1. Go to repository → **Actions** → **Deploy**
2. Click **"Run workflow"**
3. Click **"Run workflow"** button

**Auto-trigger:**
- Push to `main` branch (if files changed in `src/**`, `deployments/**`, `scripts/deploy.sh`)

**What happens:**
1. Validates Docker Compose files and scripts
2. Sets up Tailscale, SSH, and SOPS on runner
3. Gets Tailscale IP from encrypted secrets
4. Verifies SSH connectivity
5. Deploys application services via SSH (production certificates)
6. Runs health checks

**Certificate details:**
- Let's Encrypt PRODUCTION environment
- Trusted by all browsers
- **Rate limited:** 50 certificates/week, 5 validation failures/hour

**After completion:**
- All services running (api, ai, mcp, auth, ui, traefik, portainer)
- Production certificates active
- Services health-checked

---

## API Clients

### Hostinger API

**`scripts/hostinger-api.sh`** - VPS Operations
- Operations: `get-details`, `recreate`, `snapshot`, `get-action`, `wait-action`
- Used by local rebuild scripts
- Used by GitHub Actions workflows
- **Requires:** `HOSTINGER_API_KEY` environment variable

**Example usage:**
```bash
bash scripts/hostinger-api.sh get-details
bash scripts/hostinger-api.sh recreate <template_id> <password> <post_install_script_id>
```

### Tailscale API

**`scripts/tailscale-api.sh`** - Auth Key Generation
- Operations: `generate-key`, `get-ip`, `wait-for-device`
- Used by local rebuild scripts
- Used by GitHub Actions workflows
- **Requires:** `TAILSCALE_API_KEY` from secrets (loaded via `load-secrets.sh`)

**Example usage:**
```bash
source scripts/load-secrets.sh
bash scripts/tailscale-api.sh generate-key
bash scripts/tailscale-api.sh get-ip hill90-vps
```

---

## Benefits Comparison

### Local API-Based Automation (Current)
- ✅ Fast (2-3 min rebuild + 5-10 min bootstrap)
- ✅ No MCP dependencies
- ✅ Full automation via `make` commands
- ✅ Single approval per command
- ✅ Works offline (no GitHub Actions required)
- ✅ Immediate execution

### GitHub Actions (Ready to Use)
- ✅ No local dependencies
- ✅ Audit trail via GitHub Actions logs
- ✅ Can trigger from anywhere (web UI, mobile, API)
- ✅ Automatic deployments on push
- ✅ Parallel execution possible
- ✅ Team collaboration (anyone with access can trigger)
- ✅ Secrets managed in GitHub (encrypted at rest)

---

## Workflow Files

- `.github/workflows/recreate-vps.yml` - VPS OS rebuild (Step 1, auto-triggers config-vps)
- `.github/workflows/config-vps.yml` - Infrastructure bootstrap (Step 2, auto-triggered or manual)
- `.github/workflows/deploy.yml` - Application deployment (Step 3, production certificates)
- `.github/workflows/tailscale.yml` - Tailscale ACL GitOps workflow

---

## Post-Install Script

**Script ID:** 2396 (bootstrap-ansible)

The post-install script is a minimal Ansible bootstrap script that:
- Installs Python3, pip, git, curl, sudo
- Sets up passwordless sudo
- Prepares system for Ansible bootstrap

Stored in secrets: `HOSTINGER_POST_INSTALL_SCRIPT_ID=2396`

---

## Troubleshooting GitHub Actions

### Workflow fails at "Run make recreate-vps"
- Check `HOSTINGER_API_KEY` is valid
- Check `TAILSCALE_API_KEY` is valid
- Check Hostinger API status: https://status.hostinger.com
- View workflow logs for specific error message

### Workflow fails at "Run make config-vps"
- Check `VPS_SSH_PRIVATE_KEY` is complete (includes header/footer)
- Check Ansible is installed on runner
- Check VPS IP is reachable
- View Ansible output in workflow logs

### Workflow fails at "Deploy services"
- Check `SOPS_AGE_KEY` is correct
- Check Tailscale network connectivity
- SSH manually to debug: `ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>`

### Secrets are not committed
- Check git config in workflow
- Check write permissions for GitHub Actions
- Check branch protection rules don't block Actions commits

### Tailscale connection issues
- Verify `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` are correct
- Check OAuth client has `auth_keys` scope
- Check `tag:ci` exists in Tailscale ACL

### Real Issues Encountered During Testing

#### Git Commit Permissions (Expected, Non-Blocking)
**Symptom:** Workflow fails at "Commit updated secrets" step
**Cause:** GitHub Actions may not have permissions to push commits
**Impact:** Non-blocking - secrets are updated locally in encrypted file
**Solution:**
- Workflow will continue successfully even if commit fails
- Secrets file (`prod.enc.env`) is still updated with new IPs
- Optional: Enable write permissions in workflow settings if commits are desired

#### Tailscale ACL SSH Access
**Symptom:** Cannot SSH to VPS via Tailscale even though VPS is connected
**Cause:** Missing ACL rule allowing admin users to SSH to VPS
**Solution:** Add admin SSH rule to `policy.hujson`:
```json
{
  "action": "accept",
  "src":    ["autogroup:admin"],
  "dst":    ["tag:vps"],
  "users":  ["root", "deploy", "autogroup:nonroot"],
}
```
Then push to main - ACL GitOps workflow will deploy automatically.

#### IP Updates in Secrets
**Symptom:** Need to manually update IPs in secrets after recreate
**Cause:** Expected behavior - VPS gets new IPs on each recreate
**Impact:** Minimal - workflow captures and updates IPs automatically
**Solution:**
- `make recreate-vps` updates `VPS_IP` automatically
- `make config-vps` extracts and updates `TAILSCALE_IP` automatically
- Both commands handle secrets updates without manual intervention

---

## Key Files

- `scripts/recreate-vps.sh` - Local rebuild automation (Hostinger API)
- `scripts/config-vps.sh` - Local bootstrap automation (Ansible)
- `scripts/hostinger-api.sh` - Hostinger API client
- `scripts/tailscale-api.sh` - Tailscale API client
- `.github/workflows/recreate-vps.yml` - GitHub Actions rebuild workflow
- `.github/workflows/deploy.yml` - GitHub Actions deployment workflow
