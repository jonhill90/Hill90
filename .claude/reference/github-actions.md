# GitHub Actions Automation Reference

## Overview

**Hybrid approach:** Both Mac-based (local scripts) and GitHub Actions automation are available.

- ✅ **Mac/Local:** Use `make recreate-vps` + `make config-vps` (API-based, no LLM needed)
- ✅ **GitHub Actions:** Full automation via Hostinger API (no human interaction)

## Current Local Workflow (Mac)

```bash
# 2-command rebuild (API-based, fully automated)
make recreate-vps                      # Rebuild via Hostinger API
make config-vps VPS_IP=<ip>            # Bootstrap with Ansible
```

**No MCP tools needed** - Uses Hostinger API and Tailscale API directly.

## Available GitHub Actions Workflows

### VPS Rebuild Workflow

**`.github/workflows/rebuild-vps.yml`** - Full VPS Rebuild
- Manual trigger (workflow_dispatch)
- Uses Hostinger API for OS rebuild
- Automated bootstrap, deploy, and verification
- Auto-updates secrets with new IPs
- **Status:** Ready to implement when needed

### Deployment Workflow

**`.github/workflows/deploy.yml`** - Automated Deployment
- Triggers on push to main (or manual)
- Validates infrastructure
- Deploys via SSH over Tailscale
- Extended health checks
- **Status:** Ready to implement when needed

## API Clients

### Hostinger API

**`scripts/hostinger-api.sh`** - VPS Operations
- Operations: get-details, recreate, snapshot, get-action, wait-action
- Used by local rebuild scripts
- Can be used by GitHub Actions
- **Requires:** HOSTINGER_API_KEY environment variable

### Tailscale API

**`scripts/tailscale-api.sh`** - Auth Key Generation
- Operations: generate-key
- Used by local rebuild scripts
- Can be used by GitHub Actions
- **Requires:** TAILSCALE_API_KEY from secrets

## Setup GitHub Actions (When Needed)

To enable GitHub Actions automation, add these secrets to GitHub repository settings:

**Required Secrets:**
```bash
# Hostinger API
HOSTINGER_API_KEY=<api_key>
HOSTINGER_VPS_ID=1264324
HOSTINGER_POST_INSTALL_SCRIPT_ID=2396

# Tailscale API
TAILSCALE_API_KEY=<api_key>

# VPS Access
VPS_SSH_PRIVATE_KEY=<contents of ~/.ssh/remote.hill90.com>

# Secrets Decryption
SOPS_AGE_KEY=<contents of infra/secrets/keys/age-prod.key>
```

**How to obtain Hostinger API key:**
1. Login to Hostinger control panel: https://hpanel.hostinger.com
2. Navigate to API settings
3. Generate a new API key
4. Add to GitHub Secrets: `HOSTINGER_API_KEY`

**How to obtain Tailscale API key:**
1. Login to Tailscale admin console: https://login.tailscale.com/admin/settings/keys
2. Generate API key with device write permissions
3. Add to secrets: `make secrets-update KEY=TAILSCALE_API_KEY VALUE="<key>"`

## Benefits of Current Approach

**Local API-Based Automation:**
- ✅ Fast (2-3 min rebuild + 5-10 min bootstrap)
- ✅ No MCP dependencies
- ✅ Full automation via `make` commands
- ✅ Single approval per command
- ✅ Works offline (no GitHub Actions required)

**GitHub Actions (Future):**
- ✅ No local dependencies
- ✅ Audit trail via GitHub Actions logs
- ✅ Can trigger from anywhere
- ✅ Automatic deployments on push
- ✅ Parallel execution possible

## Current Workflow Options

**Option 1: Mac/Local (API-based scripts) - CURRENT**
```bash
# Fully automated, 2 commands
make recreate-vps
make config-vps VPS_IP=<ip>
```

**Option 2: GitHub Actions - FUTURE**
```
# When implemented
GitHub Actions → Rebuild VPS workflow → Done
```

Currently using Option 1 (local API-based scripts). Option 2 (GitHub Actions) is ready to implement when needed but not required since local workflow is fully automated.

## Post-Install Script

**Script ID:** 2396 (bootstrap-ansible)

The post-install script is a minimal Ansible bootstrap script that:
- Installs Python3, pip, git, curl, sudo
- Sets up passwordless sudo
- Prepares system for Ansible bootstrap

Stored in secrets: `HOSTINGER_POST_INSTALL_SCRIPT_ID=2396`

## Key Files

- `scripts/recreate-vps.sh` - Local rebuild automation (Hostinger API)
- `scripts/config-vps.sh` - Local bootstrap automation (Ansible)
- `scripts/hostinger-api.sh` - Hostinger API client
- `scripts/tailscale-api.sh` - Tailscale API client
- `.github/workflows/` - GitHub Actions workflows (ready when needed)
