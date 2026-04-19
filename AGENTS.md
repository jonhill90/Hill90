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
   - Run primer at session start (`$primer` in Codex, `/primer` in Claude/Copilot).
3. **Linear for persistent tracking**
   - Use Linear for all real work.
   - Status flow: `todo` -> `doing` -> `review` -> `done`.
4. **Deploy on VPS, not local Mac**
   - All deploy/rebuild actions run on VPS over SSH/Tailscale.
   - Use `bash scripts/deploy.sh <service> prod` (canonical) or `make deploy-<service>` (convenience).
5. **Context collapse recovery is mandatory**
   - After any context compaction/collapse, restate current task + active workflow from summary, then run primer before making changes or running commands.
6. **Closed-loop planning for non-trivial changes**
   - Non-trivial changes (3+ files, new features, policy work) require a closed-loop plan with all 9 sections.
   - Use `/closing-the-loop` skill for the template and checklist.

## Required PR Workflow

This is the required flow for Claude, Codex, and Copilot-assisted changes.

1. **Orient** — run primer (`$primer` in Codex, `/primer` in Claude/Copilot).
2. **Plan** — produce a closed-loop plan (`/closing-the-loop`), get approval. Non-trivial changes require all 9 sections. Trivial changes (< 3 files, docs-only) may skip.
3. **Implement**
   - Code: Red -> Green -> Refactor
   - Infra/docs: direct surgical edits
4. **Verify locally** — run relevant checks (`bats`, `shellcheck`, compose validation, etc.).
5. **Create branch** — `git checkout -b <type>/<description>`.
6. **Commit** — required format below.
7. **Push** — `git push -u origin <branch>`.
8. **Create PR** — `gh pr create` with summary bullets + test plan checklist.
   - Use `.github/pull_request_template.md` and include validation evidence per `.github/docs/validation-matrix.md`.
9. **CI gates** — tests, security scan, Copilot review.
   - Advisory process signal: `Policy Gate (Advisory)` workflow warns on missing Linear/validation evidence.
10. **Watch checks** — monitor PR checks to completion (`gh pr checks <number> --watch`).
11. **Address feedback** — fix CI/review findings, then re-watch checks until all required checks are green.
12. **Merge** — `gh pr merge --squash --delete-branch` only after all required checks are green.
   - Never use `--admin` or `--force` to bypass branch protections.
13. **Post-merge deploy** — push-to-main triggers path-filtered deploy workflows.
   - Do not run manual deploy commands after merge unless explicitly requested for incident recovery.

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
```

When an AI assistant contributes to a commit, append the co-author trailer using the format recommended by that assistant's provider (e.g., `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` for Claude).

## Deployment Rule

Deployments must run on VPS over SSH/Tailscale, not on local Mac.

- **Canonical (VPS/CI)**: `bash scripts/deploy.sh <service> prod` — works everywhere, no `make` required.
- **Convenience (local Mac)**: `make deploy-<service>` — thin wrappers that call the scripts above.

For manual VPS access, see `docs/runbooks/deployment.md`.

## Quick Command Map

`make` targets are convenience wrappers for local Mac. On VPS/CI, use the script form directly.

| Operation | Script (canonical) | Make (convenience) |
|-----------|-------------------|--------------------|
| Recreate VPS | `bash scripts/vps.sh recreate` | `make recreate-vps` |
| Configure VPS | `bash scripts/vps.sh config <ip>` | `make config-vps VPS_IP=<ip>` |
| Deploy infra | `bash scripts/deploy.sh infra prod` | `make deploy-infra` |
| Deploy database | `bash scripts/deploy.sh db prod` | `make deploy-db` |
| Deploy auth | `bash scripts/deploy.sh auth prod` | `make deploy-auth` |
| Deploy API | `bash scripts/deploy.sh api prod` | `make deploy-api` |
| Deploy AI | `bash scripts/deploy.sh ai prod` | `make deploy-ai` |
| Deploy MCP | `bash scripts/deploy.sh mcp prod` | `make deploy-mcp` |
| Deploy MinIO | `bash scripts/deploy.sh minio prod` | `make deploy-minio` |
| Deploy vault | `bash scripts/deploy.sh vault prod` | `make deploy-vault` |
| Deploy UI | `bash scripts/deploy.sh ui prod` | `make deploy-ui` |
| Deploy knowledge | `bash scripts/deploy.sh knowledge prod` | `make deploy-knowledge` |
| Deploy observability | `bash scripts/deploy.sh observability prod` | `make deploy-observability` |
| Deploy all apps | `bash scripts/deploy.sh all prod` | `make deploy-all` |
| Health check | `bash scripts/ops.sh health` | `make health` |
| Backup all | `bash scripts/backup.sh backup-all` | `make backup` |
| Backup service | `bash scripts/backup.sh backup <svc>` | `make backup-<svc>` |
| List backups | `bash scripts/backup.sh list` | `make backup-list` |
| Prune backups | `bash scripts/backup.sh prune [days]` | `make backup-prune` |
| Rollback service | `bash scripts/rollback.sh rollback <svc> [ref]` | `make rollback SERVICE=<svc>` |
| Classify changes | `bash scripts/rollback.sh classify <svc> [ref]` | `make rollback-classify SERVICE=<svc>` |
| View secret | `bash scripts/secrets.sh view infra/secrets/prod.enc.env <key>` | `make secrets-view KEY=<key>` |
| Get secret (raw) | `bash scripts/secrets.sh get infra/secrets/prod.enc.env <key>` | `make secrets-get KEY=<key>` |
| Update secret | `bash scripts/secrets.sh update infra/secrets/prod.enc.env <key> <val>` | `make secrets-update KEY=<key> VALUE=<v>` |
| Vault init | `bash scripts/vault.sh init` | `make vault-init` |
| Vault unseal | `bash scripts/vault.sh unseal` | `make vault-unseal` |
| Vault status | `bash scripts/vault.sh status` | `make vault-status` |
| Vault setup | `bash scripts/vault.sh setup` | `make vault-setup` |
| Vault seed | `bash scripts/vault.sh seed` | `make vault-seed` |
| Vault sync to SOPS | `bash scripts/vault.sh sync-to-sops` | `make vault-sync-to-sops` |
| Vault auto-unseal | `bash scripts/vault.sh auto-unseal` | `make vault-auto-unseal` |
| Vault setup sync token | `bash scripts/vault.sh setup-sync-token` | `make vault-setup-sync-token` |
| Vault bootstrap AppRoles | `bash scripts/vault.sh bootstrap-approles` | `make vault-bootstrap-approles` |
| Vault sync (automated) | GitHub Actions: `vault-sync-to-sops` workflow | Manual trigger or weekly schedule |
| Check secrets schema | `python3 scripts/checks/check_secrets_schema.py` | `make check-secrets-schema` |

## Reference Map

- Harness details and platform parity: `.github/docs/harness-reference.md`
- Contribution/PR operations: `.github/docs/contribution-workflow.md`
- Validation evidence expectations: `.github/docs/validation-matrix.md`
- Linear task lifecycle details: `.claude/references/task-management.md`
- Deployment architecture: `.github/docs/deployment.md`
- VPS rebuild runbook: `docs/runbooks/vps-rebuild.md`
- Disaster recovery runbook: `docs/runbooks/disaster-recovery.md`
- Secrets workflow guide: `docs/runbooks/secrets-workflow.md`
- Architecture overview: `docs/architecture/overview.md`
- Secrets architecture: `docs/architecture/secrets-model.md`
- Vault auto-unseal runbook: `docs/runbooks/vault-unseal.md`
- Secrets schema validation: `docs/runbooks/secrets-schema-validation.md`
- API auth verification: `docs/runbooks/api-auth-verification.md`
- Observability runbook: `docs/runbooks/observability.md`
- Deployment runbook: `docs/runbooks/deployment.md`
- Closed-loop planning skill: `.github/skills/closing-the-loop/SKILL.md`
- Public documentation site (Mintlify): `docs/site/` (source) — https://docs.hill90.com (live); `docs/` is internal
- MCP gateway evaluation: `docs/architecture/mcp-gateway-evaluation.md`

## Guardrails

Do:
- Use MCP tools for fresh documentation before implementation.
- Track work in Linear and keep state current.
- Use `bash scripts/*.sh` or `make` wrappers for operations.
- Validate behavior locally before PR.
- Complete closed-loop plan before implementing non-trivial changes.
- Update `services/api/src/openapi/openapi.yaml` when adding or changing API routes. CI enforces spec-vs-route drift.

Don't:
- Use TodoWrite as persistent task tracking.
- Run deploy scripts locally on Mac.
- Use `gh pr merge --admin` or `gh pr merge --force`.
- Run local long-running dev servers (`npm run dev`, `npm start`, `pnpm dev`, `yarn dev`) unless explicitly asked in the current turn.
- Skip CI/review feedback.
- Add speculative features outside request scope.
- If a hook blocks an action, do not retry or work around it. Stop immediately and ask the user what to do next.
- Treat any PR whose verification required ad-hoc manual workarounds — chmod/chown, direct container edits, one-off env var injection, temporary DNS/network changes, direct DB mutation outside documented recovery procedures, or vault/container changes not represented in code, automation, or runbooks — as a merge blocker by default. Documented runbook-backed operations (e.g. `vault.sh unseal`, documented recovery steps) are not workarounds. The default merge recommendation is `patch first`. Before merging the agent must: (1) identify root cause, (2) determine least-privilege durable fix, (3) state a merge recommendation:
  - `patch first` (default) — fix the root cause in this PR before merge.
  - `split follow-up` — permitted only when all of: (a) the current PR's changes are safe to ship independently, (b) the workaround does not weaken security posture, and (c) the workaround does not break on redeploy. Create an immediate follow-up Linear issue, link it in the PR body, and document why the split is safe.
  - `merge now` — permitted only when investigation shows the supposed workaround was not actually required, or the durable fix is already included in the PR.
