# GitHub Actions Automation Reference

## Overview

**Hybrid approach:** Both Mac-based (local scripts) and GitHub Actions automation are available.

- ✅ **Mac/Local:** Use `make recreate-vps` + `make config-vps` (API-based, fully automated)
- ✅ **GitHub Actions:** Full automation via Hostinger API (tested and operational)

## Workflow Status & Test Results

### VPS Recreate Workflow - ✅ TESTED & OPERATIONAL

**Last tested:** January 19, 2026
**Test run:** [#21128156365](https://github.com/jonhill90/Hill90/actions/runs/21128156365)
**Status:** All critical operations succeeded

**What worked:**
- ✅ VPS recreate via Hostinger API
- ✅ Automatic wait for SSH availability
- ✅ Bootstrap via Ansible (all 9 stages)
- ✅ Service deployment via SSH over Tailscale
- ✅ New VPS IPs captured automatically
- ✅ All 6 services running and healthy (traefik, auth, postgres, ai, api, mcp)

**Expected behavior (non-blocking):**
- Git commit/push may fail if running locally (permissions - can be ignored)
- Secrets are updated locally regardless of git push status

**Current VPS (from successful test):**
- Public IP: 76.13.26.69 (SSH blocked by firewall)
- Tailscale IP: 100.108.199.106 (use for SSH access)
- Hostname: srv1264324.hstgr.cloud

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

### VPS Recreate Workflow

**`.github/workflows/recreate-vps.yml`** - Simplified VPS Rebuild
- **Trigger:** Manual only (`workflow_dispatch`)
- **Workflow:** Uses `make recreate-vps` and `make config-vps` commands
- **Features:**
  - Destructive operation with confirmation required (type "REBUILD")
  - Fully automated rebuild, bootstrap, and deployment
  - Auto-updates secrets with new IPs
  - Commits changes back to repository
  - ~13 minutes total execution time
- **Status:** ✅ Ready to use (requires GitHub secrets setup)

**Key improvements over manual workflow:**
- ✅ 133 lines (vs 274 lines in old manual version)
- ✅ Single source of truth (uses make commands)
- ✅ No duplicate logic to maintain
- ✅ Automatic secret updates and git commits

### Deployment Workflow

**`.github/workflows/deploy.yml`** - Automated Deployment
- **Trigger:** Push to main (paths: `src/**`, `deployments/**`, `scripts/deploy.sh`)
- **Also:** Manual via `workflow_dispatch`
- **Features:**
  - Validates infrastructure before deployment
  - Deploys via SSH over Tailscale
  - Extended health checks
  - Supports staging and production certificates
- **Status:** ✅ Ready to use (requires GitHub secrets setup)

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

### VPS Recreate Workflow

**When to use:**
- Rebuild VPS from scratch (destructive operation)
- Same functionality as local `make recreate-vps` + `make config-vps`

**How to trigger:**
1. Go to repository → **Actions** → **VPS Rebuild (Automated)**
2. Click **"Run workflow"**
3. Type **"REBUILD"** exactly in the confirmation input
4. Click **"Run workflow"** button
5. Watch the workflow execution in real-time

**Expected execution timeline:**
- Setup: ~1 minute
- make recreate-vps: ~5 minutes (VPS rebuild + wait)
- make config-vps: ~5 minutes (Ansible bootstrap)
- Deploy: ~2 minutes
- Commit & cleanup: ~30 seconds
- **Total:** ~13 minutes

**What happens:**
1. Validates confirmation input
2. Sets up Tailscale, SSH, and SOPS on runner
3. Runs `make recreate-vps` (generates keys, rebuilds VPS, updates secrets)
4. Waits for SSH to be available on new VPS
5. Runs `make config-vps` (Ansible bootstrap)
6. Deploys services via SSH over Tailscale
7. Commits updated secrets back to repository
8. Cleans up backup files

### Deployment Workflow

**When to use:**
- Deploy code changes to VPS
- Runs automatically on push to main (if files changed in `src/**`, `deployments/**`, `scripts/deploy.sh`)
- Can also trigger manually

**How to trigger manually:**
1. Go to repository → **Actions** → **Deploy to VPS**
2. Click **"Run workflow"**
3. Select environment: `prod`
4. Choose certificate type:
   - ✅ **Staging** (unlimited, recommended for testing)
   - ⚠️ **Production** (rate limited, use for production only)
5. Click **"Run workflow"**

**What happens:**
1. Validates Docker Compose files and scripts
2. Sets up Tailscale, SSH, and SOPS on runner
3. Gets Tailscale IP from encrypted secrets
4. Verifies SSH connectivity
5. Deploys services via SSH
6. Waits for services to start
7. Runs health checks
8. Extended health check job verifies container status

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

- `.github/workflows/recreate-vps.yml` - VPS rebuild workflow (uses `make` commands)
- `.github/workflows/deploy.yml` - Deployment workflow

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
