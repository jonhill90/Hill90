# Claude Code Operating Manual for Hill90 VPS

**READ THIS FIRST when working on this project.**

## Core Principles

### 1. You Have Full Control of This VPS Infrastructure

- Direct SSH access to the VPS is available
- MCP tools provide OS rebuild capabilities
- You can install, configure, and deploy everything
- If something breaks, reinstalling the OS is fast and easy
- Run commands directly rather than asking the user to run them
- All operations use Makefile commands for consistency

### 2. ALWAYS Use Linear for Task Tracking

**Linear is THE task tracking system for this project. Use it for ALL work.**

**Critical:** Linear issues persist across Claude sessions and context resets. TodoWrite does NOT persist and gets wiped between sessions.

**When to use Linear:**

- Starting any work (create issue, set to "doing")
- Breaking down multi-step tasks (create issues for each step)
- Tracking progress across sessions (Linear survives context resets)
- Documenting what was done (update issue descriptions)

**Quick Commands:**

- Create: `create_issue(title, team="AI", project="Hill90", state="todo")`
- Update: `update_issue(id, state="doing|review|done", description="...")`
- List: `list_issues(project="Hill90", assignee="me", state="doing")`

**Status flow:** `todo` → `doing` → `review` → `done`

**See `.claude/reference/task-management.md` for complete workflows.**

## Rebuild-First Approach

**When encountering infrastructure problems, rebuilding is often faster than debugging.**

The VPS can be rebuilt in ~5-10 minutes (2 commands). This makes it practical to rebuild rather than troubleshoot in most cases.

**Examples where rebuild is preferred:**

- Tailscale connectivity issues → Rebuild
- SSH access problems → Rebuild
- Service startup failures → Rebuild
- Configuration errors → Rebuild

**Why this approach works:**

- Rebuild is fully automated (5-10 minutes)
- Zero manual intervention required
- Infrastructure is ephemeral by design
- Faster than investigating complex issues

**The rebuild process is 2 commands:**

```bash
make recreate-vps                    # 1. Rebuild VPS (auto-waits, auto-updates secrets)
make config-vps VPS_IP=<ip>          # 2. Bootstrap (auto-extracts Tailscale IP)
```

## Important Guidelines

### Deployment Location

**Deployments must run on the VPS via SSH, not on the local Mac.**

When deploying:

```bash
# CORRECT - Run deploy script ON THE VPS via SSH
ssh -i ~/.ssh/remote.hill90.com deploy@<vps-ip> 'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod'

# INCORRECT - deploys locally instead of on VPS
make deploy  # This runs LOCALLY on Mac, not on VPS
bash scripts/deploy.sh prod  # This runs LOCALLY, not on VPS
```

The deploy script builds and runs Docker containers **wherever you execute it**, so SSH to the VPS first to ensure proper deployment.

## Your Capabilities

### 1. VPS Management (via API)

Direct access to Hostinger VPS via Hostinger API:

- `make recreate-vps` - Rebuild OS (fully automated, destructive)
- `make config-vps VPS_IP=<ip>` - Bootstrap infrastructure (Ansible)
- `bash scripts/hostinger-api.sh get-details` - Get VPS info
- `bash scripts/hostinger-api.sh get-action <id>` - Check action status
- Full VPS lifecycle management via Makefile

### 2. SSH Access

- **VPS Public IP:** 76.13.26.69 (public SSH blocked by firewall)
- **VPS Tailscale IP:** 100.108.199.106 (use this for SSH)
- SSH as: `deploy` user (or `root` immediately after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- Full command execution available via SSH
- **Example:** `ssh -i ~/.ssh/remote.hill90.com deploy@100.108.199.106`

### 3. Makefile Commands

All operations are done via Makefile - check `make help` for full list.

**The Makefile is organized into logical sections:**

- **Infrastructure Setup** - Tailscale, secrets initialization (rare operations)
- **VPS Rebuild & Bootstrap** - Destructive rebuild operations
- **Development** - Local development environment
- **Deployment** - Build and deploy to VPS
- **Monitoring & Maintenance** - Health checks, logs, SSH
- **Service Management** - Start, stop, restart services
- **Database & Backups** - Backup operations

**Key commands:**

- `make help` - Show all available commands (organized by section)
- `make recreate-vps` - Rebuild VPS (fully automated)
- `make config-vps VPS_IP=<ip>` - Bootstrap VPS infrastructure
- `make deploy` - Deploy all services (STAGING certificates)
- `make deploy-production` - Deploy with PRODUCTION certificates (rate-limited!)
- `make health` - Check service health
- `make ssh` - SSH to VPS
- `make secrets-view KEY=<key>` - View a secret value
- `make secrets-update KEY=<key> VALUE=<value>` - Update a secret

## VPS Rebuild & Operations

**See `.claude/reference/vps-operations.md` for complete rebuild workflows.**

### Quick Reference

**Full rebuild (5-10 minutes):**

```bash
make recreate-vps                    # 1. Rebuild (auto-waits, auto-updates secrets)
make config-vps VPS_IP=<ip>          # 2. Bootstrap (auto-extracts Tailscale IP)
```

**When things break:** Rebuild is usually the fastest solution.

## Deployment

**See `.claude/reference/deployment.md` for complete deployment workflows.**

### Quick Reference

```bash
make deploy         # STAGING certs (safe, unlimited)
make deploy-production  # PRODUCTION certs (rate-limited!)
make health         # Verify services
```

**Important**: Deployments run on VPS via SSH, not locally on Mac.

## Secrets Management

**See `.claude/reference/secrets.md` for complete secrets workflows.**

### Quick Reference

```bash
make secrets-view KEY=<key>              # View secret
make secrets-update KEY=<key> VALUE=<v>  # Update secret (auto-backup)
make secrets-edit                        # Interactive edit
```

## Tailscale Management

**See `.claude/reference/tailscale.md` for complete Tailscale workflows.**

### Quick Reference

- Auth keys are **automatically generated** during `make recreate-vps` (90-day expiry)
- **SSH via Tailscale IP**: 100.108.199.106 (public SSH blocked by firewall)
- **ACL management via GitOps**: Edit `policy.hujson` → push to main → auto-deployed

**ACL GitOps workflow** (`.github/workflows/tailscale.yml`):
- Push to main → ACL deployed automatically
- Pull request → ACL tested for validity
- Manages SSH access, tags, and network grants

## GitHub Actions

**See `.claude/reference/github-actions.md` for complete automation workflows.**

**Quick Reference**: Hybrid approach - both tested and operational

- **Mac/Local:** Hostinger API via `make` commands (fully automated, recommended)
- **GitHub Actions:** Full VPS recreate workflow (tested January 19, 2026)

**VPS Recreate Workflow** - ✅ Tested successfully:
- Workflow: `.github/workflows/recreate-vps.yml`
- Trigger: Manual via GitHub UI (type "RECREATE" to confirm)
- Timeline: ~13 minutes (recreate + bootstrap + deploy)
- Test run: Successfully rebuilt VPS with all 6 services running

**Tailscale ACL GitOps** - ✅ Operational:
- Workflow: `.github/workflows/tailscale.yml`
- Automatic ACL deployment on push to main
- ACL testing on pull requests
- Policy file: `policy.hujson`

## Key Operational Notes

1. **Linear task tracking** - ALWAYS use Linear for task tracking (persists across sessions, unlike TodoWrite)
2. **SSH access** - Direct SSH to VPS is available; run commands directly
3. **API-based rebuild** - Fully automated via `make recreate-vps` + `make config-vps`
4. **Command execution** - Run commands directly rather than requesting user action
5. **Makefile usage** - All operations use `make` commands for consistency
6. **Automation** - Bootstrap is fully automated (git, clone, age key transfer, Tailscale)
7. **Git commits** - Commit frequently with clear messages

## Baseline Status: ✅ ACHIEVED

The VPS baseline is complete:

1. ✅ VPS is bootstrapped (deploy user, Docker, firewall)
2. ✅ Infrastructure fully automated (2 commands, zero warnings)
3. ✅ **Tailscale SSH access works** (100.108.199.106)
4. ✅ Public SSH is locked down (firewall blocks port 22)
5. ✅ **GitHub Actions VPS recreate tested** (Run #21128156365)
6. ✅ **Tailscale ACL GitOps operational** (automatic deployment on push)

**Baseline achieved!** Infrastructure automation is production-ready with both local and GitHub Actions workflows operational.

---
