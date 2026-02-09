# AGENTS.md

## Project

Hill90 — a microservices platform on Hostinger VPS with full infrastructure automation, Tailscale-secured SSH, and Docker Compose deployments.

This file is the single source of truth for all AI coding assistants.
Chain: `AGENTS.md` (source) <- `CLAUDE.md` (symlink) <- `.github/copilot-instructions.md` (symlink to AGENTS.md)

---

## Fresh Information First

**Do not rely on training data for APIs, SDKs, or framework patterns.**

Always check live documentation before writing code:

| MCP Server | Use For |
|------------|---------|
| **context7** | Library and framework documentation (npm, PyPI, crates, etc.) |
| **microsoft-learn** | Microsoft, Azure, .NET, and M365 documentation |
| **deepwiki** | GitHub repository documentation and wikis |

Skills and agent patterns evolve — verify against current docs, not memory.

---

## Orient First

Run `/primer` at the start of every session before diving into tasks. This analyzes project structure, documentation, key files, and current state — loading essential context for everything that follows.

---

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

**Status flow:** `todo` -> `doing` -> `review` -> `done`

**See `.claude/references/task-management.md` for complete workflows.**

### 3. Rebuild-First Approach

**When encountering infrastructure problems, rebuilding is often faster than debugging.**

The VPS can be rebuilt in ~5-10 minutes (2 commands). This makes it practical to rebuild rather than troubleshoot in most cases.

**The rebuild process is 4 steps:**

```bash
make recreate-vps                    # 1. Rebuild VPS (auto-waits, auto-updates secrets)
make config-vps VPS_IP=<ip>          # 2. Configure OS (no containers)
make deploy-infra                    # 3. Deploy infrastructure (Traefik, Portainer)
make deploy-all                      # 4. Deploy all app services
```

### 4. Think Before Coding

- Surface assumptions explicitly — don't hide confusion
- Present tradeoffs when multiple approaches exist
- Ask clarifying questions before implementing ambiguous requests
- Plan complex changes before touching code

### 5. Simplicity First

- Write the minimum code that solves the problem
- No speculative features, no "just in case" abstractions
- If you're overcomplicating it, rewrite — don't patch
- Three similar lines beat a premature abstraction

### 6. Surgical Changes

- Touch only what's needed to accomplish the task
- Match existing code style — indentation, naming, patterns
- Don't refactor adjacent code, add docstrings, or "improve" untouched files
- A bug fix doesn't need surrounding cleanup

### 7. Goal-Driven Execution

- Define success criteria before writing implementation
- Verify your work — run tests, check output, validate behavior
- Loop until the task is actually done, not just attempted
- If blocked, try a different approach before asking for help

---

## Deployment Location

**Deployments must run on the VPS via SSH, not on the local Mac.**

```bash
# CORRECT - Run deploy script ON THE VPS via SSH
ssh -i ~/.ssh/remote.hill90.com deploy@<vps-ip> 'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy/deploy-all.sh prod'

# INCORRECT - deploys locally instead of on VPS
make deploy  # This runs LOCALLY on Mac, not on VPS
```

The deploy script builds and runs Docker containers **wherever you execute it**, so SSH to the VPS first to ensure proper deployment.

---

## Repository Structure

```
Hill90/
├── AGENTS.md                          # Source of truth (this file)
├── CLAUDE.md -> AGENTS.md             # Symlink for Claude Code
├── .mcp.json                          # MCP server configuration
├── Makefile                           # All operations via make commands
├── policy.hujson                      # Tailscale ACL policy (GitOps)
│
├── .github/                           # Source of truth for all content
│   ├── docs/                          # Platform-agnostic reference docs
│   │   ├── deployment.md
│   │   ├── vps-operations.md
│   │   ├── dns.md
│   │   ├── secrets.md
│   │   ├── tailscale.md
│   │   ├── github-actions.md
│   │   ├── best-practices.md
│   │   ├── context-engineering.md
│   │   └── tdd-workflow.md
│   ├── skills/                        # Skill source directories
│   │   ├── primer/SKILL.md
│   │   ├── linear/SKILL.md
│   │   ├── gh-cli/SKILL.md
│   │   ├── context7-sh/SKILL.md
│   │   ├── context7-py/SKILL.md
│   │   ├── context7-ps/SKILL.md
│   │   ├── ms-learn/SKILL.md
│   │   ├── obsidian/SKILL.md
│   │   ├── youtube-transcript/SKILL.md
│   │   ├── az-devops/SKILL.md
│   │   ├── create-skill/SKILL.md
│   │   ├── validate-skill/SKILL.md
│   │   └── lint-agents/SKILL.md
│   ├── agents/                        # Agent definitions
│   │   ├── code-reviewer.md
│   │   └── researcher.md
│   ├── copilot-instructions.md -> ../AGENTS.md
│   ├── instructions/                  # Copilot scoped instructions
│   │   ├── infrastructure.instructions.md
│   │   ├── workflows.instructions.md
│   │   ├── skill-authoring.instructions.md
│   │   ├── agent-authoring.instructions.md
│   │   ├── testing.instructions.md
│   │   ├── documentation.instructions.md
│   │   └── reference-freshness.instructions.md
│   ├── prompts/                       # Prompt evaluation
│   │   ├── README.md
│   │   ├── eval-checklist.md
│   │   └── fixtures/template.md
│   ├── plugins/                       # Plugins (placeholder)
│   └── workflows/                     # GitHub Actions workflows
│
├── .claude/                           # Claude Code platform directory
│   ├── skills -> ../.github/skills    # Symlink
│   ├── agents -> ../.github/agents    # Symlink
│   ├── references/                    # Knowledge docs (mixed)
│   │   ├── deployment.md -> ../../.github/docs/deployment.md
│   │   ├── vps-operations.md -> ../../.github/docs/vps-operations.md
│   │   ├── dns.md -> ../../.github/docs/dns.md
│   │   ├── secrets.md -> ../../.github/docs/secrets.md
│   │   ├── tailscale.md -> ../../.github/docs/tailscale.md
│   │   ├── github-actions.md -> ../../.github/docs/github-actions.md
│   │   ├── best-practices.md -> ../../.github/docs/best-practices.md
│   │   ├── context-engineering.md -> ../../.github/docs/context-engineering.md
│   │   ├── tdd-workflow.md -> ../../.github/docs/tdd-workflow.md
│   │   ├── task-management.md         # Claude-specific (Linear MCP tools)
│   │   ├── skills-guide.md            # Claude-specific
│   │   ├── hooks-guide.md             # Claude-specific
│   │   ├── memory-system.md           # Claude-specific
│   │   ├── subagents-guide.md         # Claude-specific
│   │   ├── contribution-workflow.md   # Claude-specific
│   │   ├── repository-conventions.md  # Claude-specific
│   │   ├── validation-requirements.md # Claude-specific
│   │   └── patterns/                  # Proven patterns
│   │       ├── skill-patterns.md
│   │       ├── agent-patterns.md
│   │       └── memory-patterns.md
│   └── rules/                         # Claude Code-specific path rules
│       ├── infrastructure.md
│       ├── workflows.md
│       ├── skill-authoring.md
│       ├── agent-authoring.md
│       ├── testing.md
│       ├── documentation.md
│       └── reference-freshness.md
│
├── .codex/                            # Codex CLI platform directory
│   ├── agents -> ../.github/agents    # Symlink
│   ├── skills -> ../.github/skills    # Symlink
│   └── config.toml                    # MCP servers, approval policy, sandbox
│
├── deployments/                       # Docker compose and deployment configs
│   └── compose/prod/                  # Per-service compose files
├── infra/                             # Infrastructure automation
│   ├── ansible/                       # Ansible playbooks
│   ├── dns/                           # DNS templates
│   └── secrets/                       # SOPS-encrypted secrets
├── scripts/                           # Automation and utility scripts
│   ├── deploy/                       # Deployment scripts
│   │   ├── _service.sh               # Per-service deploy helper
│   │   ├── deploy-infra.sh
│   │   └── deploy-all.sh
│   ├── infra/                        # Infrastructure management
│   │   ├── hostinger.sh              # Hostinger API CLI
│   │   ├── recreate-vps.sh
│   │   ├── config-vps.sh
│   │   ├── tailscale-api.sh
│   │   └── tailscale-setup.sh
│   ├── secrets/                      # Secrets management
│   │   ├── load-secrets.sh
│   │   ├── secrets-init.sh
│   │   ├── secrets-view.sh
│   │   ├── secrets-update.sh
│   │   ├── secrets-edit.sh
│   │   └── generate-all-secrets.sh
│   ├── validate/                     # Validation scripts
│   │   ├── validate-infra.sh
│   │   ├── validate-compose.sh
│   │   ├── validate-secrets.sh
│   │   └── validate-traefik.sh
│   └── ops/                          # Operational scripts
│       ├── health-check.sh
│       └── backup.sh
├── src/                               # Application source code
│   └── services/                      # Microservices (auth, api, ai, mcp)
└── docs/                              # Project documentation
```

### Architecture

- **`.github/`** is the source of truth for all skills, agents, docs, and instructions
- **`.claude/`** and **`.codex/`** contain symlinks back to `.github/`
- **`CLAUDE.md`** symlinks to `AGENTS.md` — Claude Code reads the same source
- **`.github/copilot-instructions.md`** symlinks to `AGENTS.md` — GitHub Copilot gets the same guidance
- **`.github/docs/`** holds platform-agnostic reference docs (deployment, VPS ops, DNS, secrets, Tailscale, GitHub Actions)
- **`.claude/references/`** holds Claude-specific knowledge + symlinks to agnostic docs from `.github/docs/`
- **`.claude/rules/`** holds path-specific authoring rules for Claude Code (`paths:` frontmatter)
- **`.github/instructions/`** holds scoped instruction files for GitHub Copilot (`applyTo:` frontmatter)
- **`.codex/config.toml`** configures MCP servers, approval policy, and sandbox mode for Codex CLI
- **`AGENTS.md`** is read natively by Codex CLI from the project root (no symlink needed)
- **`AGENTS.override.md`** (git-ignored) provides local Codex overrides, analogous to `CLAUDE.local.md`

---

## VPS Capabilities

### SSH Access

- **VPS Public IP:** 76.13.26.69 (public SSH blocked by firewall)
- **VPS Tailscale IP:** 100.108.199.106 (use this for SSH)
- SSH as: `deploy` user (or `root` immediately after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- **Example:** `ssh -i ~/.ssh/remote.hill90.com deploy@100.108.199.106`

### VPS Management (via API)

- `make recreate-vps` - Rebuild OS (fully automated, destructive)
- `make config-vps VPS_IP=<ip>` - Bootstrap infrastructure (Ansible)
- `bash scripts/infra/hostinger.sh get-details` - Get VPS info
- Full VPS lifecycle management via Makefile

### Makefile Commands

All operations are done via Makefile - check `make help` for full list.

**Key commands:**

| Command | Purpose |
|---------|---------|
| `make help` | Show all available commands |
| `make recreate-vps` | Rebuild VPS (fully automated) |
| `make config-vps VPS_IP=<ip>` | Configure VPS OS (no containers) |
| `make deploy-infra` | Deploy infrastructure (Traefik, dns-manager, Portainer) |
| `make deploy-all` | Deploy all app services |
| `make deploy-auth` | Deploy auth + postgres only |
| `make deploy-api` | Deploy API only |
| `make deploy-ai` | Deploy AI only |
| `make deploy-mcp` | Deploy MCP only |
| `make health` | Check service health |
| `make ssh` | SSH to VPS |
| `make secrets-view KEY=<key>` | View a secret value |
| `make secrets-update KEY=<key> VALUE=<v>` | Update a secret |

---

## Quick Reference

### VPS Rebuild (4 Steps)

```bash
make recreate-vps                    # 1. Rebuild VPS (auto-waits, auto-updates secrets)
make config-vps VPS_IP=<ip>          # 2. Configure OS (no containers)
make deploy-infra                    # 3. Deploy infrastructure
make deploy-all                      # 4. Deploy all app services
```

**When things break:** Rebuild is usually the fastest solution.

### Per-Service Deployment

```bash
make deploy-infra   # Traefik, dns-manager, Portainer
make deploy-auth    # Auth + PostgreSQL
make deploy-api     # API service
make deploy-ai      # AI service
make deploy-mcp     # MCP service
make deploy-all     # All app services (not infra)
```

### Secrets Management

```bash
make secrets-view KEY=<key>              # View secret
make secrets-update KEY=<key> VALUE=<v>  # Update secret (auto-backup)
make secrets-edit                        # Interactive edit
```

### Tailscale

- Auth keys are **automatically generated** during `make recreate-vps` (90-day expiry)
- **SSH via Tailscale IP**: 100.108.199.106 (public SSH blocked by firewall)
- **ACL management via GitOps**: Edit `policy.hujson` -> push to main -> auto-deployed

### GitHub Actions

**Hybrid approach** - both tested and operational:

- **Mac/Local:** Hostinger API via `make` commands (fully automated, recommended)
- **GitHub Actions:** Full VPS recreate workflow (tested January 19, 2026)
- **Tailscale ACL GitOps:** Automatic ACL deployment on push to main

**See reference docs in `.claude/references/` for complete workflows.**

---

## Conventions

### Makefile Usage

- All operations use `make` commands for consistency
- Check `make help` for the full organized command list
- Infrastructure and application deployments are separate
- Per-service deployment is preferred over monolithic deploy

### Deployment Patterns

- Infrastructure deploys first (creates Docker networks)
- Auth (with postgres) before api, ai, mcp (dependency order)
- GitHub Actions uses PRODUCTION certificates; local uses STAGING
- Let's Encrypt rate limits: 5 failures/hour, 50 certs/week

### Naming

- Services: `auth`, `api`, `ai`, `mcp` (short, lowercase)
- Compose files: `docker-compose.{service}.yml` in `deployments/compose/prod/`
- Scripts: organized by function in `scripts/` subdirectories:
  - Deploy: `scripts/deploy/_service.sh`, `scripts/deploy/deploy-{target}.sh`
  - Infra: `scripts/infra/hostinger.sh`, `scripts/infra/recreate-vps.sh`
  - Secrets: `scripts/secrets/secrets-{action}.sh`
  - Validate: `scripts/validate/validate-{target}.sh`
  - Ops: `scripts/ops/health-check.sh`, `scripts/ops/backup.sh`
- Workflows: `{action}.yml` in `.github/workflows/`

---

## MCP Servers

This repository uses three MCP servers for fresh documentation plus project-specific MCP tools:

### context7

Fetches up-to-date library and framework documentation.

```
Use: /context7 or resolve-library-id + get-library-docs
When: Working with any library, framework, or SDK
```

### microsoft-learn

Queries official Microsoft documentation.

```
Use: /ms-learn or microsoft_learn_search
When: Azure, .NET, M365, Windows, or any Microsoft technology
```

### deepwiki

Fetches GitHub repository documentation and wikis.

```
Use: deepwiki tools
When: Understanding a GitHub project's architecture or API
```

### Hostinger & Linear MCP Tools

Project-specific MCP tools are available for VPS management and task tracking:
- **Hostinger MCP:** VPS rebuild, DNS management, firewall operations
- **Linear MCP:** Issue creation, status updates, project management

---

## Workflow

Use Claude Code's built-in plan mode for feature planning and implementation.

1. **Explore** — run /primer to orient, then dig deeper as needed
2. **Plan** — surface tradeoffs and get alignment
3. **Red** — write failing tests that define success criteria
4. **Green** — write minimum code to pass tests
5. **Refactor** — clean up while keeping tests green
6. **Commit** — clean, descriptive commit messages

For infrastructure-only changes (deployment, VPS ops, config), skip steps 3-5 and go directly from Plan to Commit.

---

## Baseline Status: ACHIEVED

The VPS baseline is complete:

1. VPS is bootstrapped (deploy user, Docker, firewall)
2. Infrastructure fully automated (2 commands, zero warnings)
3. **Tailscale SSH access works** (100.108.199.106)
4. Public SSH is locked down (firewall blocks port 22)
5. **GitHub Actions VPS recreate tested** (Run #21128156365)
6. **Tailscale ACL GitOps operational** (automatic deployment on push)
7. **Let's Encrypt DNS-01 working** (Tailscale-only services: Traefik, Portainer)
8. **Traefik dashboard authentication** (Auto-generated .htpasswd, secured with bcrypt)
9. **Deployment automation complete** (GitHub Actions runner creates all required files)

**Baseline achieved!** Infrastructure automation is production-ready with both local and GitHub Actions workflows operational.

---

## Clean Code Checklist

Before committing any change:

- [ ] **Does it work?** — Tested, verified, produces expected output
- [ ] **Is it simple?** — No unnecessary abstraction or indirection
- [ ] **Is it focused?** — Does one thing well
- [ ] **Does it match existing patterns?** — Naming, structure, style
- [ ] **Deployments tested?** — For infra changes, verify on VPS
- [ ] **Secrets safe?** — No plaintext secrets committed

---

## Do's and Don'ts

### Do

- Use MCP tools for fresh documentation before writing code
- Use Linear for ALL task tracking (persists across sessions)
- Run commands directly via SSH — don't ask the user to run them
- Use `make` commands for all operations
- Rebuild when debugging takes longer than rebuilding (~5-10 min)
- Deploy via SSH to VPS, not locally on Mac
- Ask clarifying questions when requirements are ambiguous
- Commit frequently with clear messages

### Don't

- Rely on training data for API signatures, SDK methods, or configuration formats
- Use TodoWrite for task tracking (doesn't persist across sessions)
- Run deploy scripts locally on Mac (they must run on VPS via SSH)
- Skip validation — always verify deployments and service health
- Add features that weren't requested
- Modify files outside the scope of the current task
- Commit without reviewing changes
- Use PRODUCTION Let's Encrypt locally (rate-limited — use staging)
