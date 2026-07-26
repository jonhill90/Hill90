# Contributing to Hill90

Hill90 is homelab infrastructure for a single Hostinger VPS: Ansible
provisioning, Traefik edge routing, an observability stack, SOPS/OpenBao
secrets, and Tailscale-secured SSH.

> **Scope:** Hill90 is not an application host. The AI agent application that
> once lived here was shelved in June 2026 and removed in July 2026. See
> [Infra/app separation](docs/decisions/infra-app-separation.md); the code is
> preserved at the `archive/app-stack-final` tag.

## Pull Request Workflow

1. **Plan** — for anything touching three or more files, agree on the approach
   before writing code.
2. **Implement** — tests first for code changes; direct surgical edits for
   infra and docs.
3. **Verify locally** — run the relevant checks (`bats`, `shellcheck`, compose
   validation).
4. **Branch** — `git checkout -b <type>/<description>`.
5. **Commit** — see the format below.
6. **Push** — `git push -u origin <branch>`.
7. **Open the PR** — `gh pr create` with summary bullets and a test plan
   checklist, using `.github/pull_request_template.md`.
8. **Watch checks** — `gh pr checks <number> --watch`.
9. **Address feedback** — fix CI and review findings, then re-watch until all
   required checks are green.
10. **Merge** — `gh pr merge --squash --delete-branch`, only once required
    checks pass. Never use `--admin` or `--force` to bypass branch protections.
11. **Post-merge deploy** — pushing to `main` triggers path-filtered deploy
    workflows. Do not run manual deploy commands after a merge unless you are
    recovering from an incident.

### Branch Naming

| Type | Prefix |
|---|---|
| Feature | `feat/<description>` |
| Refactor | `refactor/<description>` |
| Bug fix | `fix/<description>` |
| Docs | `docs/<description>` |
| Enhancement | `enhance/<description>` |
| Chore | `chore/<description>` |

### Commit Format

```text
<type>: <short description>

<body explaining why, not what>
```

## Deployment Rule

Deployments run on the VPS over SSH/Tailscale, never from a local Mac.

- **Canonical (VPS/CI):** `bash scripts/deploy.sh <service> prod` — works
  everywhere, no `make` required.
- **Convenience (local Mac):** `make deploy-<service>` — thin wrappers around
  the scripts above.

For manual VPS access, see [docs/runbooks/deployment.md](docs/runbooks/deployment.md).

## Command Map

`make` targets are convenience wrappers for local use. On the VPS or in CI, use
the script form directly.

| Operation | Script (canonical) | Make (convenience) |
|-----------|-------------------|--------------------|
| Recreate VPS | `bash scripts/vps.sh recreate` | `make recreate-vps` |
| Configure VPS | `bash scripts/vps.sh config <ip>` | `make config-vps VPS_IP=<ip>` |
| Deploy infra | `bash scripts/deploy.sh infra prod` | `make deploy-infra` |
| Deploy vault | `bash scripts/deploy.sh vault prod` | `make deploy-vault` |
| Deploy observability | `bash scripts/deploy.sh observability prod` | `make deploy-observability` |
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
| Check secrets schema | `python3 scripts/checks/check_secrets_schema.py` | `make check-secrets-schema` |

Vault-to-SOPS sync also runs as the `vault-sync-to-sops` GitHub Actions
workflow, on a weekly schedule or manual trigger.

## Reference Map

**Runbooks**

- [VPS rebuild](docs/runbooks/vps-rebuild.md)
- [Disaster recovery](docs/runbooks/disaster-recovery.md)
- [Deployment](docs/runbooks/deployment.md)
- [Secrets workflow](docs/runbooks/secrets-workflow.md)
- [Secrets schema validation](docs/runbooks/secrets-schema-validation.md)
- [Vault auto-unseal](docs/runbooks/vault-unseal.md)
- [Observability](docs/runbooks/observability.md)

**Architecture**

- [Overview](docs/architecture/overview.md)
- [Secrets model](docs/architecture/secrets-model.md)

**Operational reference**

- [Deployment architecture](docs/reference/deployment.md)
- [GitHub Actions automation](docs/reference/github-actions.md)
- [VPS operations](docs/reference/vps-operations.md)
- [DNS management](docs/reference/dns.md)
- [Secrets management](docs/reference/secrets.md)
- [Tailscale management](docs/reference/tailscale.md)

## Guardrails

**Do**

- Validate behavior locally before opening a PR.
- Use `bash scripts/*.sh` or the `make` wrappers for operations.

**Don't**

- Run deploy scripts locally on a Mac.
- Use `gh pr merge --admin` or `gh pr merge --force`.
- Run long-running local dev servers (`npm run dev`, `npm start`, `pnpm dev`)
  unless you actually need one.
- Skip CI or review feedback.

### Manual Workarounds Are a Merge Blocker

If verifying a PR required an ad-hoc manual workaround — `chmod`/`chown`,
direct container edits, one-off env var injection, temporary DNS or network
changes, direct DB mutation outside documented recovery procedures, or
vault/container changes not represented in code, automation, or runbooks —
treat the PR as blocked by default. Documented runbook-backed operations (for
example `vault.sh unseal`) are not workarounds.

Before merging: identify the root cause, determine the least-privilege durable
fix, and pick one of:

- **Patch first** (default) — fix the root cause in this PR before merge.
- **Split follow-up** — permitted only when all of: (a) the current changes are
  safe to ship independently, (b) the workaround does not weaken security
  posture, and (c) the workaround does not break on redeploy. File the
  follow-up issue immediately and link it in the PR body.
- **Merge now** — permitted only when the supposed workaround turned out to be
  unnecessary, or the durable fix is already in the PR.
