# Manual Steps Log - VPS Rebuild Automation

This document tracks manual interventions required during automated workflows.

## 2026-01-19: Automated Rebuild Test

### What Worked Automatically
- ✅ Tailscale auth key generation via API
- ✅ Secrets updates (TAILSCALE_AUTH_KEY)
- ✅ Root password generation
- ✅ VPS rebuild via Hostinger API (135s)
- ✅ Ansible bootstrap (Docker, SOPS, age, Tailscale, SSH lockdown)
- ✅ Repository cloning
- ✅ Age key transfer and symlinking

### Manual Steps Required

1. **TAILSCALE_IP Update** (Minor)
   - **Why**: config-vps.sh tries to SSH to get Tailscale IP, but SSH is already locked to Tailscale network
   - **What**: Had to read IP from Ansible output (100.66.237.66) and run `make secrets-update KEY=TAILSCALE_IP VALUE="100.66.237.66"`
   - **Fix**: Parse Tailscale IP from Ansible output instead of SSHing

### Bugs Fixed During Test

1. **secrets-update.sh** - Special character handling
   - Issue: Tailscale auth keys contain special chars that broke JSON parsing
   - Fix: Use `jq -Rs` to properly escape values

2. **recreate-vps.sh** - ANSI code capture
   - Issue: Was capturing colored output from tailscale-api.sh, including ANSI codes
   - Fix: Extract only last line (the actual auth key)

3. **bootstrap-v2.yml** - Git clone permissions
   - Issue: `become_user: deploy` caused permission denied when creating /opt/hill90/app
   - Fix: Remove become_user, let root create directory, then fix ownership

## Summary

**Total rebuild time**: ~3 minutes
**Manual interventions**: 1 (TAILSCALE_IP update)
**Automation level**: 95% - Only one minor step requires manual input
