# Claude Code Operating Manual for Hill90 VPS

**READ THIS FIRST when working on this project.**

## Core Principle

**You have full control of this VPS infrastructure.**

- Direct SSH access to the VPS is available
- MCP tools provide OS rebuild capabilities
- You can install, configure, and deploy everything
- If something breaks, reinstalling the OS is fast and easy
- Run commands directly rather than asking the user to run them
- All operations use Makefile commands for consistency

## Rebuild-First Approach

**When encountering infrastructure problems, rebuilding is often faster than debugging.**

The VPS can be rebuilt in ~10 minutes (2 commands). This makes it practical to rebuild rather than troubleshoot in most cases.

**Examples where rebuild is preferred:**
- Tailscale connectivity issues → Rebuild
- SSH access problems → Rebuild
- Service startup failures → Rebuild
- Configuration errors → Rebuild

**Why this approach works:**
- Rebuild is fully automated (10 minutes)
- All tools and access are available
- Infrastructure is ephemeral by design
- Faster than investigating complex issues

**The rebuild process is 2 commands:**
```bash
make rebuild-full-auto                     # 1. Prep + display MCP params
# Use MCP to rebuild OS                    # 2. Rebuild via MCP (5 min)
make rebuild-full-auto-post-mcp VPS_IP=X   # 3. Bootstrap + deploy + verify
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

### 1. VPS Management (via MCP Tools)
Direct access to Hostinger VPS via MCP tools:
- `mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1` - Rebuild OS (destructive)
- `mcp__MCP_DOCKER__VPS_getVirtualMachineDetailsV1` - Get VPS info
- Full VPS lifecycle management

### 2. SSH Access
- **VPS Public IP:** 76.13.26.69 (public SSH blocked by firewall)
- **VPS Tailscale IP:** 100.68.116.66 (use this for SSH)
- SSH as: `deploy` user (or `root` immediately after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- Full command execution available via SSH
- **Example:** `ssh -i ~/.ssh/remote.hill90.com deploy@100.68.116.66`

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
- `make tailscale-setup` - Automated Tailscale setup (Terraform + secrets)
- `make rebuild-bootstrap VPS_IP=<ip> ROOT_PASSWORD=<pw>` - Bootstrap VPS after rebuild
- `make deploy` - Deploy all services (STAGING certificates)
- `make deploy-production` - Deploy with PRODUCTION certificates (rate-limited!)
- `make health` - Check service health
- `make ssh` - SSH to VPS
- `make secrets-view KEY=<key>` - View a secret value
- `make secrets-update KEY=<key> VALUE=<value>` - Update a secret

## Task Management

**Use Linear for task tracking.** See `.claude/reference/task-management.md` for complete workflows.

**Key Rule**: Linear issues persist across context resets (PLAN → EXEC). TodoWrite gets wiped.

**Quick Commands**:
- Create: `create_issue(title, team="AI", project="Hill90", state="todo")`
- Update: `update_issue(id, state="doing|review|done")`
- List: `list_issues(project="Hill90", assignee="me", state="doing")`

**Status flow**: `todo` → `doing` → `review` → `done`

## VPS Rebuild & Operations

**See `.claude/reference/vps-operations.md` for complete rebuild workflows.**

### Quick Reference

**Fastest rebuild (5-7 minutes):**

```bash
make rebuild-optimized                    # 1. Prep
# Run MCP rebuild (Claude Code only)      # 2. MCP
make rebuild-optimized-post-mcp VPS_IP=X  # 3. Bootstrap + deploy
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

```bash
make tailscale-setup    # Setup auth key (90-day expiry)
make tailscale-rotate   # Rotate expired key
```

**SSH via Tailscale IP**: 100.68.116.66 (public SSH blocked by firewall)

## GitHub Actions

**See `.claude/reference/github-actions.md` for complete automation workflows.**

**Quick Reference**: Hybrid approach available
- **Mac/Manual:** MCP tools via Claude Code (interactive)
- **GitHub Actions:** Hostinger API (full automation, no LLM)

## Key Operational Notes

1. **SSH access** - Direct SSH to VPS is available; run commands directly
2. **MCP tools** - OS rebuild capability via MCP tools
3. **Command execution** - Run commands directly rather than requesting user action
4. **Makefile usage** - All operations use `make` commands for consistency
5. **Automation** - Bootstrap is fully automated (git, clone, age key transfer)
6. **Git commits** - Commit frequently with clear messages

## Baseline Status: ✅ ACHIEVED

The VPS baseline is complete:
1. ✅ VPS is bootstrapped (deploy user, Docker, firewall)
2. ✅ Services are deployed and healthy
3. ✅ **Tailscale SSH access works** (100.88.97.65)
4. ✅ Public SSH is locked down (firewall blocks port 22)

**Baseline achieved!** Ready to build the actual application.

**Note:** HTTPS currently rate-limited by Let's Encrypt (too many rebuilds). Will work after 2026-01-19 15:43:41 UTC.

---

**Remember: The user built this infrastructure FOR YOU to manage. Use it.**
