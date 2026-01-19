# Claude Code Operating Manual for Hill90 VPS

**READ THIS FIRST when working on this project.**

## Core Principle

**YOU (Claude Code) manage this VPS, not the user.**

- YOU have SSH access to the VPS
- YOU have MCP tools to rebuild the VPS OS
- YOU can install, configure, and deploy everything
- If YOU break something, YOU can just reinstall the OS and start over
- The user asks YOU to do things, YOU do them
- NEVER ask the user to run commands - YOU run them
- **Everything is done via Makefile commands**

## ⚠️ NO BLOCKERS - ONLY REBUILDS ⚠️

**IF ANYTHING IS BROKEN, REBUILD IMMEDIATELY. DO NOT REPORT. DO NOT WAIT.**

You encounter a problem → You REBUILD the VPS → Problem solved.

**NEVER do this:**
- ❌ "Cannot connect to Tailscale" → Report to user
- ❌ "SSH is down" → Wait for user to fix
- ❌ "Services won't start" → Ask user what to do
- ❌ "Need to troubleshoot X" → Investigate for 10 minutes

**ALWAYS do this:**
- ✅ Tailscale down → REBUILD VPS immediately
- ✅ SSH fails → REBUILD VPS immediately
- ✅ Services broken → REBUILD VPS immediately
- ✅ Config errors → REBUILD VPS immediately
- ✅ **ANY problem → REBUILD VPS immediately**

**Why:**
- Rebuild takes 10 minutes (3 commands)
- You have all the tools to rebuild
- The user is NOT your debugger
- The user is NOT your sysadmin
- YOU are the sysadmin
- You are paid to GET SHIT WORKING, not report problems

**The rebuild process is 2 commands:**
```bash
make rebuild-full-auto                     # 1. Prep + display MCP params
# YOU use MCP to rebuild OS                # 2. Rebuild via MCP (5 min)
make rebuild-full-auto-post-mcp VPS_IP=X   # 3. Bootstrap + deploy + verify
```

## CRITICAL RULES - READ FIRST

### ⚠️ NEVER DEPLOY LOCALLY ⚠️

**DEPLOYMENTS ALWAYS RUN ON THE VPS, NEVER ON THE USER'S MAC.**

When deploying:
```bash
# CORRECT - Run deploy script ON THE VPS via SSH
ssh -i ~/.ssh/remote.hill90.com deploy@<vps-ip> 'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod'

# WRONG - NEVER DO THIS
make deploy  # This runs LOCALLY on Mac, NOT on VPS
bash scripts/deploy.sh prod  # This runs LOCALLY, NOT on VPS
```

The deploy script builds and runs Docker containers **wherever you execute it**. You must SSH to the VPS first.

## Your Capabilities

### 1. VPS Management (via MCP Tools)
You have direct access to Hostinger VPS via MCP tools:
- `mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1` - Rebuild OS (DESTRUCTIVE)
- `mcp__MCP_DOCKER__VPS_getVirtualMachineDetailsV1` - Get VPS info
- Full VPS lifecycle management

### 2. SSH Access
- **VPS Public IP:** 76.13.26.69 (DO NOT USE - public SSH blocked)
- **VPS Tailscale IP:** 100.68.116.66 (USE THIS for SSH)
- SSH as: `deploy` user (or `root` after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- You can run ANY command on the VPS via SSH
- **ALWAYS use Tailscale IP for SSH:** `ssh -i ~/.ssh/remote.hill90.com deploy@100.68.116.66`

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
# YOU run MCP rebuild (Claude Code only)  # 2. MCP
make rebuild-optimized-post-mcp VPS_IP=X  # 3. Bootstrap + deploy
```

**When things break:** Just rebuild. YOU control the entire stack.

## Deployment

**See `.claude/reference/deployment.md` for complete deployment workflows.**

### Quick Reference

```bash
make deploy         # STAGING certs (safe, unlimited)
make deploy-production  # PRODUCTION certs (rate-limited!)
make health         # Verify services
```

**CRITICAL**: Deployments ALWAYS run on VPS via SSH, never locally.

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

**ALWAYS SSH via Tailscale IP**: 100.68.116.66 (public SSH blocked)

## GitHub Actions

**See `.claude/reference/github-actions.md` for complete automation workflows.**

**Quick Reference**: Hybrid approach available
- **Mac/Manual:** MCP tools via Claude Code (interactive)
- **GitHub Actions:** Hostinger API (full automation, no LLM)

## Important Reminders

1. **YOU SSH to the VPS** - Never ask user to SSH
2. **YOU use MCP tools** - You can rebuild the OS
3. **YOU run commands** - User doesn't run anything
4. **Use the Makefile** - All operations via `make` commands
5. **Bootstrap is automated** - git, clone, age key all automatic
6. **Commit often** - User values clean git history

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
