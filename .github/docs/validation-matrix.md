# Validation Matrix

This matrix defines which validation evidence should appear in PRs based on change type.

| Change Type | Detection Hint | Expected Validation Evidence |
|---|---|---|
| UI | `src/services/ui/**`, `platform/auth/keycloak/themes/**`, `*.css`, `*.tsx` | Playwright interaction checks, screenshots or explicit visual assertions |
| API/MCP | `src/services/api/**`, `src/services/mcp/**` | API tests (`npm test`, `pytest`) and/or `curl` response checks |
| Infra/Deploy | `deploy/**`, `platform/**`, `scripts/*.sh` | Workflow run evidence (`gh run`), deployment confirmation, health checks |
| Docs-only | `*.md` only | Link checks and concise accuracy review |

## Notes
- The `Agent Loop Gate` workflow is currently advisory (`AGENT_LOOP_STRICT=0`).
- If stricter enforcement is needed later, set `AGENT_LOOP_STRICT=1` in workflow env.
