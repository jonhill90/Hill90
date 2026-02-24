# Harness Reference

Operational harness details for Hill90 AI workflows. `AGENTS.md` is the concise policy map; this document holds deeper operational context.

## Source-Of-Truth Chain

- `AGENTS.md` (canonical policy)
- `CLAUDE.md` -> `AGENTS.md` (symlink)
- `.github/copilot-instructions.md` -> `AGENTS.md` (symlink)

## Repository Topology

```text
Hill90/
├── AGENTS.md
├── CLAUDE.md -> AGENTS.md
├── .mcp.json
├── Makefile
├── policy.hujson
├── .github/
│   ├── copilot-instructions.md -> ../AGENTS.md
│   ├── instructions/
│   ├── docs/
│   ├── skills/
│   ├── agents/
│   │   ├── code-reviewer.md
│   │   ├── researcher.md
│   │   ├── planner.md
│   │   ├── tdd-red.md
│   │   ├── tdd-green.md
│   │   └── tdd-refactor.md
│   └── workflows/
├── .claude/
│   ├── settings.json
│   ├── skills -> ../.github/skills
│   ├── agents -> ../.github/agents
│   ├── references/
│   └── rules/
├── .codex/
│   ├── agents -> ../.github/agents
│   ├── config.toml
│   └── rules/
├── .agents/
│   └── skills -> ../.github/skills
├── deploy/compose/prod/
├── platform/edge/
├── infra/
│   ├── ansible/
│   ├── dns/
│   └── secrets/
├── scripts/
│   ├── _common.sh
│   ├── deploy.sh
│   ├── secrets.sh
│   ├── validate.sh
│   ├── hostinger.sh
│   ├── vps.sh
│   ├── ops.sh
│   ├── checks/
│   └── hooks/
│       ├── shellcheck-on-edit.sh
│       ├── block-local-deploy.sh
│       └── stop-gate.sh
├── tests/scripts/
├── services/
└── docs/
```

## Platform Parity

| Platform | Global Instructions | Scoped Rules | MCP Config |
|----------|---------------------|--------------|------------|
| Claude Code | `CLAUDE.md` -> `AGENTS.md` | `.claude/rules/` | `.mcp.json` |
| GitHub Copilot | `.github/copilot-instructions.md` -> `AGENTS.md` | `.github/instructions/` | `.vscode/mcp.json` (gitignored) |
| Codex CLI | `AGENTS.md` | `.codex/rules/` | `.codex/config.toml` |

Copilot code review reads both `copilot-instructions.md` and matching `.github/instructions/*.instructions.md` based on changed paths.

## Agent Loop Signal

- PRs run `.github/workflows/agent-loop-gate.yml` (`Policy Gate (Advisory)`).
- The check is non-blocking by default and surfaces missing process evidence in PR summaries.
- Evidence expectations are defined in `.github/docs/validation-matrix.md`.
- PR authors should use `.github/pull_request_template.md` so all three agent platforms emit consistent evidence.

## Deployment Location And Access

- Deployments run on VPS over SSH/Tailscale, not locally on Mac.
- Hostname: `remote.hill90.com`
- SSH key: `~/.ssh/remote.hill90.com`
- Public SSH is blocked; use Tailscale connectivity.

Canonical deploy example:

```bash
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh all prod'
```

## Core Command Map

- `make recreate-vps`
- `make config-vps VPS_IP=<ip>`
- `make deploy-infra`
- `make deploy-minio`
- `make deploy-all`
- `make health`
- `make secrets-view KEY=<key>`
- `make secrets-update KEY=<key> VALUE=<v>`

## MCP Server Map

| Server | Skill | Purpose |
|--------|-------|---------|
| context7 | `/context7` | Library and framework docs |
| microsoft-learn | `/ms-learn` | Microsoft/Azure/.NET docs |
| deepwiki | MCP tools | GitHub repo docs/wiki answers |
| Hostinger MCP | `/hostinger` | VPS lifecycle + DNS management |
| Linear MCP | `/linear` | Issue tracking and lifecycle |

## Active Hooks (Claude Code Only)

Hooks are configured in `.claude/settings.json` and run automatically during Claude Code sessions. Copilot and Codex enforce equivalent guardrails via CI workflows and scoped instructions.

| Hook | Event | Script | Behavior |
|------|-------|--------|----------|
| shellcheck-on-edit | PostToolUse (Edit\|Write) | `scripts/hooks/shellcheck-on-edit.sh` | Runs shellcheck on edited `.sh` files (informational) |
| block-local-deploy | PreToolUse (Bash) | `scripts/hooks/block-local-deploy.sh` | Blocks local deploy commands, privileged PR merges (`--admin`/`--force`), and local dev-server starts (blocking) |
| stop-gate | Stop | `scripts/hooks/stop-gate.sh` | Verifies required checks ran during session (blocking) |

## TDD Agent Chain

Three agents enforce Red-Green-Refactor phase separation:

| Agent | Phase | Can Run Tests | Can Edit Files | Hands Off To |
|-------|-------|---------------|---------------|-------------|
| `tdd-red` | Write failing tests | No | No (Write only, in `tests/`) | `tdd-green` |
| `tdd-green` | Minimum implementation | Yes | Yes | `tdd-refactor` |
| `tdd-refactor` | Improve structure | Yes | Yes | `tdd-red` |

Handoffs are Copilot-native (frontmatter `handoffs` key). Claude Code and Codex ignore unrecognized frontmatter.

## Guardrails

Do:
- Use live docs MCPs before implementation.
- Track real work in Linear (`todo` -> `doing` -> `review` -> `done`).
- Validate locally before PR.
- Use `make` wrappers and existing scripts.
- After context compaction/collapse, restate task/workflow and run primer before acting.

Don't:
- Rely on stale memory for changing APIs/tooling.
- Run deploy scripts locally on Mac.
- Skip verification or CI gates.

## See Also

- `AGENTS.md`
- `.github/docs/contribution-workflow.md`
- `.claude/references/task-management.md`
- `docs/runbooks/vps-rebuild.md`
