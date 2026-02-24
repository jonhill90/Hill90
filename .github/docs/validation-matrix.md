# Validation Matrix

This matrix defines which validation evidence should appear in PRs based on change type.

| Change Type | Detection Hint | Expected Validation Evidence |
|---|---|---|
| UI | `services/ui/**`, `platform/auth/keycloak/themes/**`, `*.css`, `*.tsx` | Playwright interaction checks, screenshots or explicit visual assertions |
| API/MCP | `services/api/**`, `services/mcp/**` | API tests (`npm test`, `pytest`) and/or `curl` response checks |
| Infra/Deploy | `deploy/**`, `platform/**`, `scripts/*.sh` | Workflow run evidence (`gh run`), deployment confirmation, health checks |
| Infra/Stateful | `deploy/compose/**`, volume or project-name changes | Before/after volume mounts via `docker inspect`, workflow run IDs + exit status, rollback plan with recovery commands, no old-project stragglers (`docker ps --filter label=com.docker.compose.project=<old>`) |
| Docs-only | `*.md` only | Link checks and concise accuracy review |

## Notes
- The `Policy Gate (Advisory)` workflow is currently advisory (`AGENT_LOOP_STRICT=0`) for general checks.
- The `Agent Loop (Infra — Enforced)` job hard-fails when infra paths are touched and the PR body is missing required sections (Plan, Risks, Rollback, Validation Evidence).
- Non-infra PRs skip the enforced check.
