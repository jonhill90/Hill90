# Contribution Workflow

Operational pull request workflow for Hill90. This mirrors and expands the required process in `AGENTS.md`.

See also: `.github/docs/harness-reference.md` for platform parity, repository topology, and deployment location rules.

## Required PR Flow

1. **Orient**
   - Run `/primer` first.
2. **Plan**
   - Use plan mode to inspect code, write a decision-complete implementation plan, and get approval.
3. **Implement**
   - Code changes: Red -> Green -> Refactor.
   - Infra/docs changes: make direct surgical edits.
4. **Verify Locally**
   - Run relevant checks (`bats tests/scripts/`, `shellcheck`, compose validation, Traefik validation, and any targeted tests).
5. **Create Branch**
   - `git checkout -b <type>/<description>`
6. **Commit**
   - Use required format and co-author trailer.
7. **Push**
   - `git push -u origin <branch>`
8. **Create PR**
   - Use `gh pr create` with summary bullets and a test plan checklist.
9. **PR CI Gates**
   - Tests and validations (bats, compose validation, Traefik validation, shellcheck)
   - Snyk scan
   - Copilot code review via `copilot-instructions.md` and scoped `*.instructions.md`
10. **Address Feedback**
   - Resolve CI failures and Copilot review findings, then push updates.
11. **Merge**
   - Squash merge and delete branch: `gh pr merge --squash --delete-branch`
   - Never use `--admin` or `--force` to bypass branch protections.
12. **Post-Merge Deployment**
   - Push-to-main triggers path-filtered deploy workflows (`deploy-api.yml`, `deploy-auth.yml`, etc.) over SSH/Tailscale.
   - Do not run manual deploy commands after merge unless explicitly requested for incident recovery.

## Branch Naming Convention

- Feature: `feat/<description>`
- Refactor: `refactor/<description>`
- Bug fix: `fix/<description>`
- Docs: `docs/<description>`
- Enhancement: `enhance/<description>`

## Commit Message Format

```text
<type>: <short description>

<body explaining why, not what>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Linear Integration

Use Linear for all tracked work in the Hill90 project (AI team).

Status progression:
- `todo` -> `doing` -> `review` -> `done`

Minimum policy:
- Create or select a Linear issue before implementation.
- Move to `doing` when active work starts.
- Move to `review` when PR is open and checks are running.
- Move to `done` after merge and post-merge verification.
