# AGENTS.md

## Project

Hill90 is a microservices platform on Hostinger VPS with infrastructure automation, Tailscale-secured SSH, and Docker Compose deployments.

This file is the canonical AI harness policy map.
Chain: `AGENTS.md` (source) <- `CLAUDE.md` (symlink) <- `.github/copilot-instructions.md` (symlink)

## Non-Negotiables

1. **Fresh docs first**
   - Do not rely on stale memory for APIs/SDK patterns.
   - Use MCP docs tools first: `context7`, `microsoft-learn`, `deepwiki`.
2. **Orient first**
   - Run `/primer` at session start.
3. **Linear for persistent tracking**
   - Use Linear for all real work.
   - Status flow: `todo` -> `doing` -> `review` -> `done`.
4. **Deploy on VPS, not local Mac**
   - All deploy/rebuild actions run via `make` wrappers and VPS SSH.

## Required PR Workflow

This is the required flow for Claude, Codex, and Copilot-assisted changes.

1. **Orient** — run `/primer`.
2. **Plan** — explore, produce plan, get approval.
3. **Implement**
   - Code: Red -> Green -> Refactor
   - Infra/docs: direct surgical edits
4. **Verify locally** — run relevant checks (`bats`, `shellcheck`, compose validation, etc.).
5. **Create branch** — `git checkout -b <type>/<description>`.
6. **Commit** — required format below.
7. **Push** — `git push -u origin <branch>`.
8. **Create PR** — `gh pr create` with summary bullets + test plan checklist.
9. **CI gates** — tests, security scan, Copilot review.
10. **Address feedback** — fix CI/review findings.
11. **Merge** — `gh pr merge --squash --delete-branch`.
12. **Post-merge deploy** — push-to-main triggers path-filtered deploy workflows.

### Branch Naming

- Feature: `feat/<description>`
- Refactor: `refactor/<description>`
- Bug fix: `fix/<description>`
- Docs: `docs/<description>`
- Enhancement: `enhance/<description>`

### Commit Format

```text
<type>: <short description>

<body explaining why, not what>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Deployment Rule

Deployments must run on VPS over SSH/Tailscale, not on local Mac.

```bash
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh all prod'
```

## Quick Command Map

- `make recreate-vps`
- `make config-vps VPS_IP=<ip>`
- `make deploy-infra`
- `make deploy-all`
- `make health`
- `make secrets-view KEY=<key>`
- `make secrets-update KEY=<key> VALUE=<v>`

## Reference Map

- Harness details and platform parity: `.github/docs/harness-reference.md`
- Contribution/PR operations: `.github/docs/contribution-workflow.md`
- Linear task lifecycle details: `.claude/references/task-management.md`
- VPS rebuild runbook: `docs/runbooks/vps-rebuild.md`
- Architecture overview: `docs/architecture/overview.md`

## Guardrails

Do:
- Use MCP tools for fresh documentation before implementation.
- Track work in Linear and keep state current.
- Use `make` commands for operations.
- Validate behavior locally before PR.

Don't:
- Use TodoWrite as persistent task tracking.
- Run deploy scripts locally on Mac.
- Skip CI/review feedback.
- Add speculative features outside request scope.
