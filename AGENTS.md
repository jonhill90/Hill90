# AGENTS.md

## Project

Hill90 — a microservices platform on Hostinger VPS with full infrastructure automation, Tailscale-secured SSH, and Docker Compose deployments.

This file is the single source of truth for all AI coding assistants.
Chain: `AGENTS.md` (source) <- `CLAUDE.md` (symlink) <- `.github/copilot-instructions.md` (symlink)

---

## Fresh Information First

**Do not rely on training data for APIs, SDKs, or framework patterns.**

Always check live documentation before writing code:

| MCP Server | Use For |
|------------|---------|
| **context7** | Library and framework documentation (npm, PyPI, crates, etc.) |
| **microsoft-learn** | Microsoft, Azure, .NET, and M365 documentation |
| **deepwiki** | GitHub repository documentation and wikis |

---

## Orient First

Run `/primer` at the start of every session before diving into tasks. This analyzes project structure, documentation, key files, and current state.

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

Linear issues persist across Claude sessions and context resets. TodoWrite does NOT.

**Status flow:** `todo` -> `doing` -> `review` -> `done`

**See `.claude/references/task-management.md` for complete workflows.**

### 3. Rebuild-First Approach

The VPS can be rebuilt in ~5-10 minutes (4 commands):

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

### 5. Simplicity First

- Write the minimum code that solves the problem
- No speculative features, no "just in case" abstractions
- Three similar lines beat a premature abstraction

### 6. Surgical Changes

- Touch only what's needed to accomplish the task
- Match existing code style — indentation, naming, patterns
- A bug fix doesn't need surrounding cleanup

### 7. Goal-Driven Execution

- Define success criteria before writing implementation
- Verify your work — run tests, check output, validate behavior
- If blocked, try a different approach before asking for help

---

## Deployment Location

**Deployments must run on the VPS via SSH, not on the local Mac.**

```bash
# CORRECT - deploy ON THE VPS via SSH
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh all prod'
```

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
├── .github/
│   ├── copilot-instructions.md -> ../AGENTS.md
│   ├── instructions/                  # Copilot scoped instructions (applyTo:)
│   ├── docs/                          # Platform-agnostic reference docs
│   ├── skills/                        # Skill definitions
│   │   ├── primer/, linear/, gh-cli/, context7/, ms-learn/,
│   │   │   obsidian/, youtube-transcript/, hostinger/,
│   │   │   create-skill/, validate-skill/, lint-agents/
│   ├── agents/                        # Agent definitions
│   ├── prompts/                       # Prompt evaluation
│   ├── plugins/                       # Plugins (placeholder)
│   └── workflows/                     # GitHub Actions workflows
│
├── .claude/                           # Claude Code platform directory
│   ├── skills -> ../.github/skills
│   ├── agents -> ../.github/agents
│   ├── references/                    # Knowledge docs (mixed)
│   └── rules/                         # Path-specific authoring rules
│
├── .codex/                            # Codex CLI platform directory
│   ├── agents -> ../.github/agents
│   ├── config.toml
│   └── rules/
│
├── .agents/                           # Codex-native skills discovery
│   └── skills -> ../.github/skills
│
├── deployments/compose/prod/          # Docker compose files
├── platform/edge/                     # Traefik config (static + dynamic)
├── infra/
│   ├── ansible/                       # Ansible playbooks
│   ├── dns/                           # DNS templates
│   └── secrets/                       # SOPS-encrypted secrets
├── scripts/                           # Flat CLI scripts
│   ├── _common.sh                     # Shared functions
│   ├── deploy.sh                      # deploy {infra|auth|api|ai|mcp|all}
│   ├── secrets.sh                     # secrets {init|view|update|generate}
│   ├── validate.sh                    # validate {all|compose|secrets|traefik}
│   ├── hostinger.sh                   # hostinger {vps|dns} (Hostinger API)
│   ├── vps.sh                         # vps {recreate|config}
│   └── ops.sh                         # ops {health|backup}
├── tests/scripts/                     # Bats CLI tests
├── src/services/                      # Microservices (auth, api, ai, mcp)
└── docs/                              # Project documentation
```

### Architecture

- **`.github/`** is the source of truth for all skills, agents, docs
- **`.claude/`**, **`.codex/`**, **`.agents/`** contain symlinks back to `.github/`
- **`CLAUDE.md`** symlinks to `AGENTS.md` — Claude Code reads the same source
- **`.github/copilot-instructions.md`** symlinks to `AGENTS.md` — Copilot reads the same source
- **`.github/docs/`** holds platform-agnostic reference docs
- **`.claude/references/`** holds Claude-specific knowledge + symlinks to `.github/docs/`
- **`scripts/`** is flat — 6 CLI scripts with subcommands + 1 shared helper

### Platform Parity

All AI platforms read from the same source of truth:

| Platform | Global Instructions | Scoped Rules | MCP Config |
|----------|-------------------|--------------|------------|
| Claude Code | `CLAUDE.md` → `AGENTS.md` | `.claude/rules/` (`paths:`) | `.mcp.json` |
| GitHub Copilot | `.github/copilot-instructions.md` → `AGENTS.md` | `.github/instructions/` (`applyTo:`) | `.vscode/mcp.json` |
| Codex CLI | `AGENTS.md` (direct) | `.codex/rules/` | `.codex/config.toml` |

**Copilot scoped instructions** (`.github/instructions/*.instructions.md`):
- Applied automatically to matching files via `applyTo:` glob patterns
- Used by both Copilot coding agent and Copilot code review
- Use `excludeAgent: "code-review"` to exclude from PR reviews

| Instruction File | Scoped To |
|-----------------|-----------|
| `skill-authoring` | `.github/skills/**` |
| `agent-authoring` | `.github/agents/**` |
| `documentation` | `.github/docs/**` |
| `reference-freshness` | `.github/docs/**` |
| `infrastructure` | `infra/`, `deployments/`, `platform/`, `scripts/` |
| `workflows` | `.github/workflows/**` |
| `testing` | `tests/`, `**/*.py`, `**/*.sh` |

**Copilot code review** runs automatically on PRs (configured via branch rulesets).
It reads both `copilot-instructions.md` and matching `*.instructions.md` files.

---

## VPS Access

- **VPS Hostname:** `remote.hill90.com` (resolves via Tailscale DNS)
- SSH as: `deploy` user (or `root` immediately after rebuild)
- SSH key: `~/.ssh/remote.hill90.com`
- Public SSH blocked by firewall — Tailscale only

Run `make help` for the full command list. Key commands:

| Command | Purpose |
|---------|---------|
| `make recreate-vps` | Rebuild VPS (fully automated) |
| `make config-vps VPS_IP=<ip>` | Configure VPS OS |
| `make deploy-infra` | Deploy infrastructure |
| `make deploy-all` | Deploy all app services |
| `make health` | Check service health |
| `make secrets-view KEY=<key>` | View a secret |
| `make secrets-update KEY=<key> VALUE=<v>` | Update a secret |

---

## MCP Servers

| Server | Skill | Use For |
|--------|-------|---------|
| context7 | `/context7` | Library and framework docs |
| microsoft-learn | `/ms-learn` | Azure, .NET, Microsoft docs |
| deepwiki | MCP tools | GitHub repo documentation |
| Hostinger MCP | `/hostinger` | VPS rebuild, DNS management |
| Linear MCP | `/linear` | Issue creation, task tracking |

---

## Workflow

1. **Explore** — run `/primer` to orient, then dig deeper
2. **Plan** — surface tradeoffs and get alignment
3. **Red** — write failing tests that define success criteria
4. **Green** — write minimum code to pass tests
5. **Refactor** — clean up while keeping tests green
6. **Commit** — clean, descriptive commit messages

For infrastructure-only changes, skip steps 3-5.

---

## Do's and Don'ts

### Do

- Use MCP tools for fresh documentation before writing code
- Use Linear for ALL task tracking (persists across sessions)
- Run commands directly via SSH — don't ask the user to run them
- Use `make` commands for all operations
- Rebuild when debugging takes longer than rebuilding (~5-10 min)
- Deploy via SSH to VPS, not locally on Mac

### Don't

- Rely on training data for API signatures or configuration formats
- Use TodoWrite for task tracking (doesn't persist)
- Run deploy scripts locally on Mac (must run on VPS via SSH)
- Skip validation — always verify deployments and service health
- Add features that weren't requested
- Use PRODUCTION Let's Encrypt locally (rate-limited — use staging)
