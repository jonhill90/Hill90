# Tool Presets — Phase 1

## Context

Agents have tools_config (JSONB), policies, and runtime containers. The current UX requires users to configure low-level fields (`allowed_binaries`, `denied_patterns`, path lists) per agent. This phase introduces **Tool Presets** — named, reusable tool configurations. The design reuses the general route/table/FK pattern established by `model_policies` / `model_policy_id`, but intentionally diverges: presets have no ownership scoping in Phase 1 (all are shared platform resources), add `is_platform` immutability enforcement (platform seeds cannot be mutated or deleted), and use resolve-on-save semantics (preset config is copied into the agent at assignment time rather than referenced dynamically).

**Plan artifact**: This plan will be committed into the repo at `.claude/plans/curious-dazzling-nest.md` as a changed file in PR 1, satisfying the `check_plan_closed_loop.py` detection rule (`f.startswith(".claude/plans/") and f.endswith(".md")`).

**Product concept decision**: "Tool Presets" not "Skills." The current system is a policy layer — `tools_config` controls what's *allowed*, not what's *installed*. Enabling `allowed_binaries: [git]` permits access to already-installed git; it doesn't install it. "Preset" accurately describes a predefined policy configuration. Skills (implying installable, composable capabilities) are premature until the runtime supports capability extension.

**Naming**: DB/API = `tool_presets` / `tool_preset_id`. UI = "Tool Profiles." URL = `/harness/tool-profiles`.

---

## 1. Goal / Signal

After this lands:
- **Observable signal**: `GET /tool-presets` returns 4 platform presets. Agents can be created/updated with `tool_preset_id`. Agent form shows a preset dropdown. `/harness/tool-profiles` page is live.
- **User-facing impact**: Users pick a named tool profile (Minimal, Developer, Research, Operator) instead of manually configuring `allowed_binaries` and path lists. Custom configuration remains available.

---

## 2. Scope

**In scope:**
- `tool_presets` table + `tool_preset_id` FK on agents
- CRUD API for tool presets (admin-only create/update/delete)
- 4 seed platform presets (Minimal, Developer, Research, Operator)
- Resolve-on-save: assigning a preset copies its `tools_config` to the agent at that moment
- Agent form: preset dropdown with two-mode switching (preset vs custom)
- Agent detail: preset name badge in capability summary
- `/harness/tool-profiles` management page
- OpenAPI spec update (both `services/api/src/openapi/openapi.yaml` AND `docs/site/openapi.yaml`)
- "No preset selected by default" on new agents — user must explicitly choose a profile or Custom

**Out of scope:**
- "Skills" as first-class entity
- Container image variants / installable packages
- MCP client connections for agents
- User-created presets (Phase 2)
- Preset validation against container image
- Binary inventory / introspection endpoint
- Preset reapply/sync action
- Agent usage count per preset in the Tool Profiles page (removed from scope — adds a cross-table query and UI for minimal Phase 1 value; revisit in Phase 2)

**Product decision — "no preset selected by default"**: New agents have `tool_preset_id = NULL` and the existing default `tools_config` (shell disabled, filesystem disabled, health enabled). The form shows an empty dropdown prompting the user to choose. This is a deliberate UX change: it forces awareness of tool profiles without breaking backward compatibility. Agents created via API without `tool_preset_id` still work identically to today.

---

## 3. Preset Visibility & Assignment Rules

### Visibility (GET /tool-presets)

| Preset type | `is_platform` | `created_by` | Admin sees | User sees |
|-------------|---------------|--------------|------------|-----------|
| Platform seed | `true` | `NULL` | Yes | Yes |
| Admin-created | `false` | `NULL` | Yes | Yes |

Phase 1 has only admin-created and platform presets. Both are visible to all authenticated users (both admin and non-admin). The GET query for non-admins:
```sql
SELECT * FROM tool_presets ORDER BY is_platform DESC, name ASC
```
No ownership scoping needed in Phase 1 because all presets are shared resources (no user-owned presets until Phase 2).

### Mutation (POST/PUT/DELETE /tool-presets)

| Operation | Admin | Non-admin |
|-----------|-------|-----------|
| Create | Allowed (`created_by = NULL`) | 403 Forbidden |
| Update | Allowed (except `is_platform = true` presets) | 403 Forbidden |
| Delete | Allowed (except `is_platform = true` presets, and not if assigned to agents) | 403 Forbidden |

Platform presets (`is_platform = true`) are immutable and undeletable. Admin-created presets (`is_platform = false`) can be updated/deleted by admins only.

### Assignment (agents create/update with tool_preset_id)

| Caller | Can assign? | Validation |
|--------|-------------|------------|
| Admin | Any preset | Preset must exist |
| Non-admin user | Any preset | Preset must exist |

All presets are assignable by any authenticated user. This matches the model where presets are shared platform resources. The agent create/update handler validates:
1. If `tool_preset_id` is provided, query `SELECT tools_config FROM tool_presets WHERE id = $1`
2. If not found → 400 "Tool preset not found"
3. If found → overwrite agent's `tools_config` with preset's value (resolve-on-save)

### Enforcement locations

- **GET /tool-presets**: `requireRole('user')` — all authenticated users see all presets
- **POST/PUT/DELETE /tool-presets**: `requireRole('admin')` — admin check at route level
- **PUT /DELETE immutability**: Check `is_platform` column in handler — return 403 if true
- **Agent create/update**: Validate preset existence via DB lookup in `agents.ts`

---

## 4. TDD Matrix

| # | Requirement | Test name | File | Type |
|---|-------------|-----------|------|------|
| T1 | List presets returns platform seeds | `returns 4 platform presets` | routes-tool-presets.test.ts | unit |
| T2 | List presets requires auth | `rejects unauthenticated requests` | routes-tool-presets.test.ts | unit |
| T3 | Create preset requires admin | `rejects non-admin create` | routes-tool-presets.test.ts | unit |
| T4 | Create preset validates name required | `rejects create without name` | routes-tool-presets.test.ts | unit |
| T5 | Create preset validates tools_config required | `rejects create without tools_config` | routes-tool-presets.test.ts | unit |
| T6 | Create preset succeeds for admin | `admin creates preset` | routes-tool-presets.test.ts | unit |
| T7 | Update preset requires admin | `rejects non-admin update` | routes-tool-presets.test.ts | unit |
| T8 | Update platform preset blocked | `rejects update of platform preset` | routes-tool-presets.test.ts | unit |
| T9 | Delete preset requires admin | `rejects non-admin delete` | routes-tool-presets.test.ts | unit |
| T10 | Delete platform preset blocked | `rejects delete of platform preset` | routes-tool-presets.test.ts | unit |
| T11 | Delete assigned preset blocked | `rejects delete of preset assigned to agent` | routes-tool-presets.test.ts | unit |
| T12 | Delete unassigned preset succeeds | `admin deletes unassigned preset` | routes-tool-presets.test.ts | unit |
| T13 | Agent create with preset resolves tools_config | `create agent with tool_preset_id copies preset config` | routes-agents-preset.test.ts | unit |
| T14 | Agent create with invalid preset rejected | `create agent with nonexistent preset returns 400` | routes-agents-preset.test.ts | unit |
| T15 | Agent update with preset resolves tools_config | `update agent tool_preset_id copies preset config` | routes-agents-preset.test.ts | unit |
| T16 | Agent create without preset uses default tools_config | `create agent without preset uses default` | routes-agents-preset.test.ts | unit |
| T17 | Agent update clears preset (set null) | `update agent tool_preset_id to null preserves tools_config` | routes-agents-preset.test.ts | unit |
| T18 | Preset dropdown renders options | `renders preset dropdown with options` | AgentFormClient.test.tsx | vitest |
| T19 | Selecting preset shows summary | `selecting preset shows summary card` | AgentFormClient.test.tsx | vitest |
| T20 | Selecting Custom reveals manual config | `selecting Custom shows tool toggles` | AgentFormClient.test.tsx | vitest |
| T21 | Preset→Custom populates fields | `switching to Custom populates from preset` | AgentFormClient.test.tsx | vitest |
| T22 | Agent detail shows preset badge | `shows preset name badge when assigned` | AgentDetailClient.test.tsx | vitest |
| T23 | Agent detail shows Custom when no preset | `shows Custom when no preset assigned` | AgentDetailClient.test.tsx | vitest |
| T24 | Tool Profiles page lists presets | `renders preset list with badges` | ToolProfilesClient.test.tsx | vitest |
| T25 | Tool Profiles platform badge | `platform presets show Platform badge` | ToolProfilesClient.test.tsx | vitest |
| T26 | Tool Profiles expand shows config | `expanding preset shows tools_config detail` | ToolProfilesClient.test.tsx | vitest |
| T27 | Tool Profiles create form (admin) | `admin can create new preset` | ToolProfilesClient.test.tsx | vitest |
| T28 | Nav includes Tool Profiles | `nav items include tool-profiles entry` | nav-items.test.tsx (or inline) | vitest |

---

## 5. Implementation Steps

### PR 1: Database + API (backend)

**Red:**
1. Create `services/api/src/__tests__/routes-tool-presets.test.ts` — tests T1-T12 (CRUD, auth, platform immutability, delete protection)
2. Create `services/api/src/__tests__/routes-agents-preset.test.ts` — tests T13-T17 (preset assignment, resolve-on-save)
3. Run `npm test --prefix services/api` — confirm all new tests fail

**Green:**
4. Create `services/api/src/db/migrations/016_create_tool_presets.sql`:
   - `tool_presets` table (id UUID PK, name VARCHAR(128) UNIQUE NOT NULL, description TEXT, tools_config JSONB NOT NULL, is_platform BOOLEAN DEFAULT false, created_by VARCHAR(255), created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
   - `ALTER TABLE agents ADD COLUMN IF NOT EXISTS tool_preset_id UUID REFERENCES tool_presets(id)`
   - INSERT 4 seed presets with `is_platform = true, created_by = NULL`
5. Create `services/api/src/routes/tool-presets.ts` — CRUD routes reusing the general `model-policies.ts` route/table/FK structure but diverging on visibility (no ownership scoping) and immutability (`is_platform` guard):
   - GET / — `requireRole('user')`, return all presets ordered by `is_platform DESC, name ASC`
   - GET /:id — `requireRole('user')`, return single preset
   - POST / — `requireRole('admin')`, validate name + tools_config, insert with `created_by = NULL`
   - PUT /:id — `requireRole('admin')`, check `is_platform` → 403 if true, update
   - DELETE /:id — `requireRole('admin')`, check `is_platform` → 403, check agent assignment → 409, delete
6. Register route in `services/api/src/app.ts`: `app.use('/tool-presets', toolPresetsRouter)`
7. Modify `services/api/src/routes/agents.ts`:
   - In POST/PUT handlers: if `tool_preset_id` provided, query preset, copy `tools_config` to agent, store both `tool_preset_id` and resolved `tools_config`
   - If `tool_preset_id` is explicitly `null`, clear it but preserve current `tools_config`
8. Update `services/api/src/openapi/openapi.yaml`: add ToolPreset schema, CRUD paths, `tool_preset_id` field on Agent schema
9. Copy updated spec: `cp services/api/src/openapi/openapi.yaml docs/site/openapi.yaml`
10. Copy plan into repo: `cp ~/.claude/plans/curious-dazzling-nest.md .claude/plans/curious-dazzling-nest.md` — satisfies CI closed-loop detection
11. Run `npm test --prefix services/api` — confirm all tests pass

**Refactor:**
12. Review route code for duplication with model-policies, extract shared helpers if warranted (likely not worth it for Phase 1)

### PR 2: Agent form + preset picker (UI)

**Red:**
13. Add tests T18-T23 to existing `AgentFormClient.test.tsx` and `AgentDetailClient.test.tsx`
14. Run `npm test --prefix services/ui` — confirm new tests fail

**Green:**
15. Create `services/ui/src/app/api/tool-presets/route.ts` — proxy (same pattern as model-policies proxy)
16. Create `services/ui/src/app/api/tool-presets/[...path]/route.ts` — proxy
17. Modify `services/ui/src/app/agents/new/AgentFormClient.tsx`:
    - Add `presets` state, fetch from `/api/tool-presets` on mount
    - Add dropdown above existing tools section: "Tool Profile" with options from presets + "Custom"
    - When preset selected: show read-only summary card (enabled tools, binaries, fs mode), hide manual config
    - When "Custom" selected: show existing tool toggles, populate from preset values if switching from a preset
    - On submit: include `tool_preset_id` in payload (null if Custom)
18. Modify `services/ui/src/app/agents/[id]/AgentDetailClient.tsx`:
    - Fetch preset name if `tool_preset_id` is set
    - Show preset badge in Overview tab alongside tool icons
19. Modify `services/ui/src/app/agents/[id]/edit/AgentEditClient.tsx` — pass preset data
20. Run `npm test --prefix services/ui` — confirm all tests pass

### PR 3: Tool Profiles harness page (UI)

**Red:**
21. Create `services/ui/src/app/harness/tool-profiles/__tests__/ToolProfilesClient.test.tsx` — tests T24-T28
22. Run `npm test --prefix services/ui` — confirm new tests fail

**Green:**
23. Create `services/ui/src/app/harness/tool-profiles/page.tsx` — server page (auth + AppShell)
24. Create `services/ui/src/app/harness/tool-profiles/ToolProfilesClient.tsx` — follows PoliciesClient.tsx pattern:
    - List presets with name, description, tool summary badges (Terminal/Folder/Heart icons)
    - Click row to expand → show full tools_config detail
    - Platform presets: "Platform" badge, no edit/delete buttons
    - Admin-created: edit/delete buttons (admin only)
    - Create form for admins: name, description, tools_config editor (reuse existing tool toggle pattern from AgentFormClient)
25. Modify `services/ui/src/components/nav-items.ts`:
    - Add `Wrench` to lucide-react imports
    - Add `{ type: 'link', id: 'tool-profiles', label: 'Tool Profiles', href: '/harness/tool-profiles', icon: Wrench }` after Policies, before Usage
26. Run `npm test --prefix services/ui` — confirm all tests pass

---

## 6. Seed Preset Definitions

**Minimal** — _Health monitoring only. No shell or filesystem access._
```json
{
  "shell": { "enabled": false, "allowed_binaries": [], "denied_patterns": [], "max_timeout": 300 },
  "filesystem": { "enabled": false, "read_only": false, "allowed_paths": ["/workspace"], "denied_paths": ["/etc/shadow", "/etc/passwd", "/root"] },
  "health": { "enabled": true }
}
```

**Developer** — _Full dev environment: bash, git, make, curl, jq. Read-write workspace and data._
```json
{
  "shell": { "enabled": true, "allowed_binaries": ["bash", "git", "make", "curl", "jq"], "denied_patterns": ["rm -rf /", ":(){ :|:& };:"], "max_timeout": 300 },
  "filesystem": { "enabled": true, "read_only": false, "allowed_paths": ["/workspace", "/data"], "denied_paths": ["/etc/shadow", "/etc/passwd", "/root"] },
  "health": { "enabled": true }
}
```

**Research** — _Read-only with networking tools. Can fetch data but cannot modify filesystem._
```json
{
  "shell": { "enabled": true, "allowed_binaries": ["bash", "curl", "wget", "jq"], "denied_patterns": ["rm ", "mv ", "dd ", "mkfs", "> /", ">> /"], "max_timeout": 120 },
  "filesystem": { "enabled": true, "read_only": true, "allowed_paths": ["/workspace", "/data"], "denied_paths": ["/etc/shadow", "/etc/passwd", "/root"] },
  "health": { "enabled": true }
}
```

**Operator** — _All pre-installed tools including rsync and ssh. Extended timeout._
```json
{
  "shell": { "enabled": true, "allowed_binaries": ["bash", "git", "curl", "wget", "jq", "rsync", "ssh", "make", "vim"], "denied_patterns": ["rm -rf /", ":(){ :|:& };:"], "max_timeout": 600 },
  "filesystem": { "enabled": true, "read_only": false, "allowed_paths": ["/workspace", "/data", "/var/log/agentbox"], "denied_paths": ["/etc/shadow", "/etc/passwd", "/root"] },
  "health": { "enabled": true }
}
```

---

## 7. Verification Matrix

| # | Check | Command | Expected result | Category |
|---|-------|---------|-----------------|----------|
| V1 | API unit tests pass | `npm test --prefix services/api` | All tests pass including routes-tool-presets and routes-agents-preset | Tests |
| V2 | UI unit tests pass | `npm test --prefix services/ui` | All tests pass including AgentForm preset tests and ToolProfilesClient tests | Tests |
| V3 | OpenAPI spec valid | `npx --yes @redocly/cli lint services/api/src/openapi/openapi.yaml --skip-rule no-unused-components` | No errors | Static |
| V4 | OpenAPI spec synced | `diff services/api/src/openapi/openapi.yaml docs/site/openapi.yaml` | No diff | Static |
| V5 | TypeScript compiles (API) | `npx tsc --noEmit --project services/api/tsconfig.json` | No errors | Static |
| V6 | TypeScript compiles (UI) | `npx tsc --noEmit --project services/ui/tsconfig.json` | No errors | Static |
| V7 | Migration SQL valid | Review `016_create_tool_presets.sql` — table, FK, 4 seed inserts | DDL is syntactically correct, seeds match definitions in section 6 | Code review |
| V8 | CI pipeline green | `gh pr checks <number> --watch` | All required checks pass | CI |
| V9 | Closed-loop plan detected by CI | Plan file committed at `.claude/plans/curious-dazzling-nest.md` as a changed file in PR 1. CI rule: `check_plan_closed_loop.py` reads changed files matching `.claude/plans/*.md` and validates all 9 section headings are present. | `check_plan_closed_loop.py` finds all 9 sections and passes | CI |
| V10 | Preset resolves to agent config on disk | After PR 1 merge + deploy: (1) create agent with `tool_preset_id` set to Developer preset via API, (2) start agent, (3) inspect generated config: `ssh deploy@100.65.232.75 "cat /opt/hill90/agentbox-configs/<agent_id>/agent.yml"`, (4) confirm `tools.shell.allowed_binaries` contains `[bash, git, make, curl, jq]` matching the Developer preset definition | YAML `tools:` section matches the Developer preset's `tools_config` exactly | Runtime |

---

## 8. CI / Drift Gates

**Existing gates preserved (no changes):**
- `ci.yml` → TypeScript compile, Jest (API), Vitest (UI), ESLint, OpenAPI lint, OpenAPI sync diff
- `agent-loop-gate.yml` → Advisory plan check, infra enforced check (not triggered — no infra paths changed)
- `check_plan_closed_loop.py` → Validates plan sections in PR body

**OpenAPI sync enforcement**: `diff services/api/src/openapi/openapi.yaml docs/site/openapi.yaml` in CI. Both files must be updated in the same PR. Failing this check blocks merge.

**New drift risk**: If seed preset tools_config values reference binaries not in the agentbox Dockerfile, agents using those presets will have binaries in their allowlist that don't resolve at runtime. **Phase 1 mitigation**: Seed presets are manually curated against the current Dockerfile (bash, git, curl, wget, jq, openssh-client, rsync, vim, make). No automated enforcement in Phase 1. **Phase 2**: Add a CI check or runtime validation.

**No new CI gates added** in this phase.

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Preset updates don't propagate to existing agents | Expected behavior | Low — documented | Resolve-on-save is the design. Document in UI ("Profile applied at assignment time"). Phase 2 adds explicit reapply action. |
| Custom config lost on preset assignment | Medium | Medium — user frustration | Confirmation dialog in UI before overwriting. Switching preset→Custom populates fields from preset as starting point. |
| Seed preset binaries don't match Dockerfile | Low | Low — allowlist contains non-existent binary, shell tool resolves via `shutil.which()` and rejects | Curate seed presets against current Dockerfile. Phase 2 adds validation. |
| tools_config default change breaks existing agents | N/A | N/A | No default change. Existing agents without `tool_preset_id` keep their current `tools_config` unchanged. API without `tool_preset_id` parameter behaves identically to today. |
| Migration 016 conflicts with concurrent work | Low | Low | Check for migration files before implementing. Next available is 016. |

---

## 10. Definition of Done

- [ ] Migration 016 creates `tool_presets` table with 4 platform seeds and `tool_preset_id` FK on agents
- [ ] GET/POST/PUT/DELETE /tool-presets routes work with correct auth/visibility rules
- [ ] Platform presets cannot be updated or deleted (403)
- [ ] Assigned presets cannot be deleted (409)
- [ ] Agent create/update with `tool_preset_id` resolves preset's `tools_config` into agent (resolve-on-save)
- [ ] Agent create/update without `tool_preset_id` works identically to today
- [ ] Agent form shows preset dropdown with two-mode switching
- [ ] Agent detail shows preset name badge
- [ ] `/harness/tool-profiles` page lists presets with expand, platform badge, admin CRUD
- [ ] Nav includes "Tool Profiles" in Harness group (Wrench icon, after Policies, before Usage)
- [ ] Both `services/api/src/openapi/openapi.yaml` and `docs/site/openapi.yaml` updated and synced
- [ ] All API tests pass (T1-T17)
- [ ] All UI tests pass (T18-T28)
- [ ] `npx @redocly/cli lint` passes
- [ ] CI green on all PRs
- [ ] Runtime: agent created with preset → started → generated `agent.yml` contains resolved preset tools_config (V10)

---

## 11. Stop Conditions / Out-of-Scope

**Stop if:**
- Migration numbering conflicts with concurrent work (resequence before continuing)
- Seed preset binary lists prove controversial (resolve before PR 1 merge)
- Phase 1 scope expands beyond 3 PRs

**Out of scope (do not implement):**
- "Skills" as first-class entity — premature, revisit when runtime supports capability extension
- Container image variants / installable packages
- MCP client connections for agents
- User-created presets (Phase 2 — adds ownership scoping)
- Preset validation against container image contents
- Binary inventory / introspection endpoint
- Preset reapply/sync action (Phase 2 — explicit "sync agents to latest preset")
- Agent usage count per preset on the Tool Profiles page (Phase 2)
- Preset composition / merging multiple presets

---

## Plan Checklist

- [x] Goal / Signal
- [x] Scope
- [x] TDD Matrix
- [x] Implementation Steps
- [x] Verification Matrix
- [x] CI / Drift Gates
- [x] Risks & Mitigations
- [x] Definition of Done
- [x] Stop Conditions

---

## Key Files

| File | Action |
|------|--------|
| `services/api/src/db/migrations/016_create_tool_presets.sql` | Create |
| `services/api/src/routes/tool-presets.ts` | Create |
| `services/api/src/__tests__/routes-tool-presets.test.ts` | Create |
| `services/api/src/__tests__/routes-agents-preset.test.ts` | Create |
| `services/api/src/routes/agents.ts` | Modify — add `tool_preset_id` handling |
| `services/api/src/app.ts` | Modify — register tool-presets route |
| `services/api/src/openapi/openapi.yaml` | Modify — add ToolPreset schema + paths |
| `docs/site/openapi.yaml` | Modify — sync copy |
| `services/ui/src/app/api/tool-presets/route.ts` | Create |
| `services/ui/src/app/api/tool-presets/[...path]/route.ts` | Create |
| `services/ui/src/app/agents/new/AgentFormClient.tsx` | Modify — preset dropdown + two-mode |
| `services/ui/src/app/agents/[id]/AgentDetailClient.tsx` | Modify — preset badge |
| `services/ui/src/app/agents/[id]/edit/AgentEditClient.tsx` | Modify — pass preset data |
| `services/ui/src/app/harness/tool-profiles/page.tsx` | Create |
| `services/ui/src/app/harness/tool-profiles/ToolProfilesClient.tsx` | Create |
| `services/ui/src/components/nav-items.ts` | Modify — add Wrench + entry |
| `.claude/plans/curious-dazzling-nest.md` | Create (copy from ~/.claude/plans/) — CI closed-loop evidence |

### Pattern references (read-only, do not modify):
| File | Why |
|------|-----|
| `services/api/src/routes/model-policies.ts` | CRUD route pattern, visibility logic, delete protection |
| `services/api/src/__tests__/routes-model-policies.test.ts` | Test pattern (supertest, mock pool, JWT helpers) |
| `services/api/src/helpers/scope.ts` | `scopeToOwner` helper (not used for presets in Phase 1, but referenced) |
| `services/ui/src/app/harness/policies/PoliciesClient.tsx` | UI list/expand/CRUD pattern |
| `services/agentbox/app/config.py` | ToolsConfig Pydantic model (validates preset configs are valid) |
