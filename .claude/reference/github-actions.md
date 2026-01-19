# GitHub Actions Automation Reference

## Overview

**Hybrid approach:** Both Mac-based (via Claude Code) and GitHub Actions automation are available.

- ✅ **Mac/Manual:** Use MCP tools via Claude Code (convenient for interactive work)
- ✅ **GitHub Actions:** Use Hostinger API for full automation (no LLM needed)

## Available Workflows

**`.github/workflows/rebuild-vps.yml`** - Full VPS Rebuild
- ✅ **IMPLEMENTED** - Ready to use
- Manual trigger (workflow_dispatch)
- Uses Hostinger API for OS rebuild
- Automated bootstrap, deploy, and verification
- Auto-updates secrets with new IPs
- **Requires:** Hostinger API key in GitHub Secrets

**`.github/workflows/deploy.yml`** - Automated Deployment
- ✅ **IMPLEMENTED** - Ready to use
- Triggers on push to main (or manual)
- Validates infrastructure
- Deploys via SSH over Tailscale
- Extended health checks
- **Requires:** SSH key, SOPS key in GitHub Secrets

## Hostinger API Client

**`scripts/hostinger-api.sh`** - Direct API Access
- ✅ **IMPLEMENTED** - Replaces MCP tools for automation
- Operations: get-details, recreate, snapshot, list-scripts, wait-action
- Used by GitHub Actions workflows
- Can also be used manually (requires HOSTINGER_API_KEY)

## Setup GitHub Actions (One-Time)

To enable GitHub Actions automation, add these secrets to GitHub repository settings:

**Required Secrets:**
```bash
# Hostinger API (obtain from Hostinger control panel)
HOSTINGER_API_KEY=<api_key>
HOSTINGER_VPS_ID=1264324
HOSTINGER_POST_INSTALL_SCRIPT_ID=2395

# Tailscale OAuth (for GitHub Actions runners)
TAILSCALE_OAUTH_CLIENT_ID=<oauth_client_id>
TAILSCALE_OAUTH_SECRET=<oauth_secret>

# Tailscale API (for device management)
TAILSCALE_API_KEY=<api_key>
TAILSCALE_TAILNET=<tailnet_name>

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

**How to obtain Tailscale OAuth credentials:**
1. Login to Tailscale admin console: https://login.tailscale.com/admin/settings/oauth
2. Generate OAuth client for GitHub Actions
3. Add `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_SECRET` to GitHub Secrets

## Using GitHub Actions

**Rebuild VPS from GitHub:**
1. Go to Actions tab in GitHub
2. Select "VPS Rebuild (Full Automation)"
3. Click "Run workflow"
4. Type "REBUILD" to confirm
5. Wait ~10 minutes for completion

**Deploy from GitHub:**
1. Push to main branch (auto-deploys)
2. OR manually trigger from Actions tab
3. Select "Deploy to VPS"
4. Choose environment and certificate type
5. Wait for deployment + health checks

## Post-Install Script (Optimization)

**Binary pre-caching during OS rebuild:**
- ✅ **Script uploaded:** ID 2395 (hill90-cache-binaries)
- ✅ **Stored in secrets:** HOSTINGER_POST_INSTALL_SCRIPT_ID=2395
- ✅ **Used by workflows:** Enabled by default in rebuild workflow
- **Saves:** ~2-3 minutes per rebuild (caches Docker, SOPS, age, git)

## Benefits of GitHub Actions

- ✅ No local dependencies (runs on GitHub runners)
- ✅ Audit trail via GitHub Actions logs
- ✅ Can trigger from anywhere (mobile, web)
- ✅ Automatic deployments on push to main
- ✅ Parallel execution (validate, deploy, health check)
- ✅ Full automation without Claude Code

## Current Workflow Options

**Option 1: Mac via Claude Code (MCP Tools)**
```bash
# Quick and interactive
make rebuild-optimized
# Claude uses MCP to rebuild
make rebuild-optimized-post-mcp VPS_IP=<new_ip>
```

**Option 2: GitHub Actions (Hostinger API)**
```
# Fully automated
GitHub Actions → Rebuild VPS workflow → Done
```

Both work equally well. Use Mac for interactive work, GitHub Actions for automation.
