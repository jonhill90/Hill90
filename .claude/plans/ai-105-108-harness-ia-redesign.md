# AI-105/106/107/108: Harness Information Architecture Redesign

**Linear:** AI-105, AI-106, AI-107, AI-108 | **Status:** In Progress | **Date:** 2026-04-04

## Context

The Harness nav group currently has 7 items in a flat list: Connections, Models, Skills, Tools (admin), Usage, Knowledge, Shared Knowledge. Several UX problems:

1. **AI-105 — IA structure**: "Knowledge" (per-agent) is an agent-operational concern, not a control-plane surface. It belongs under Agents, not Harness. The remaining Harness items need clearer grouping.
2. **AI-106 — Rename**: "Shared Knowledge" is verbose and confusing vs "Knowledge". Rename to "Library" — shorter, clearer, distinct.
3. **AI-107 — Skill chips**: Skill cards show scope as a badge but don't visually signal elevated danger (`host_docker`, `vps_system`) prominently enough. Tool dependency count is hidden until expand.
4. **AI-108 — Tools clarity**: The Tools page subtitle says "dependencies that skills can reference" but doesn't use the term "dependency catalog" that the issue wants. Need clearer copy and a subtitle that explains the allowlist concept.

All changes are UI-only — no backend, no API routes, no database changes.

---

## 1. Goal / Signal

After this lands:
- **Harness nav** reorganized: Connections, Models, Skills, Dependencies (was Tools), Usage, Library (was Shared Knowledge) — 6 items, no Knowledge (moved)
- **Knowledge** moved to a top-level nav link (between Chat and Harness), href stays `/harness/knowledge` (no route change)
- **"Shared Knowledge"** renamed to **"Library"** in nav, page title, subtitle, and all test references
- **"Tools"** renamed to **"Dependencies"** in nav, page title, subtitle updated to "CLI tools and packages available to agent skills"
- **Skill cards** show tool dependency count badge on the summary row and scope badge uses warning icon for elevated scopes
- All existing functionality unchanged — rename only, no behavioral changes

---

## 2. Scope

**In scope:**
- `nav-items.ts` — restructure Harness group, move Knowledge to top-level, rename items
- `ToolsClient.tsx` — rename heading "Tools" → "Dependencies", update subtitle
- `tools/page.tsx` — update metadata title if present
- `SharedKnowledgeClient.tsx` — rename heading "Shared Knowledge" → "Library"
- `shared-knowledge/page.tsx` — update metadata title if present
- `SkillsClient.tsx` — add tool dependency count badge to collapsed skill row, add warning icon to elevated scope badges
- Test updates: all tests referencing renamed labels
- Sidebar/MobileDrawer tests that check nav item names

**Out of scope:**
- Route/URL changes (all routes stay at `/harness/*` — no redirects needed)
- Backend API changes
- Database changes
- Moving the Knowledge page files (page stays at `/harness/knowledge`, just nav position changes)
- New pages or layouts
- Any changes to Connections, Models, or Usage pages

---

## 3. TDD Matrix

| # | Requirement | Test Name | Type | File |
|---|---|---|---|---|
| T1 | Nav shows "Library" not "Shared Knowledge" | `nav shows Library label` | vitest | Sidebar.test.tsx |
| T2 | Nav shows "Dependencies" not "Tools" | `nav shows Dependencies label for admin` | vitest | Sidebar.test.tsx |
| T3 | Nav shows Knowledge as top-level link | `nav shows Knowledge outside Harness group` | vitest | Sidebar.test.tsx |
| T4 | Library page renders "Library" heading | `renders Library heading` | vitest | SharedKnowledgeClient.test.tsx |
| T5 | Dependencies page renders heading | `renders Dependencies heading` | vitest | ToolsClient.test.tsx |
| T6 | Dependencies page subtitle describes catalog | `renders dependency catalog subtitle` | vitest | ToolsClient.test.tsx |
| T7 | Skill card shows tool count badge | `skill card shows tool dependency count` | vitest | SkillsClient.test.tsx |
| T8 | Elevated scope badge shows warning icon | `elevated scope shows warning indicator` | vitest | SkillsClient.test.tsx |

---

## 4. Implementation Steps

### Phase A: Nav restructure (AI-105)

1. **`nav-items.ts`** — restructure:
   - Move Knowledge out of Harness group → top-level link (between Chat and Harness)
   - Rename `shared-knowledge` label: "Shared Knowledge" → "Library"
   - Rename `tools` label: "Tools" → "Dependencies", change icon from `Settings` to `Package` (lucide-react)
   - Reorder Harness children: Connections, Models, Skills, Dependencies, Usage, Library

### Phase B: Page renames (AI-106, AI-108)

2. **`SharedKnowledgeClient.tsx`** — change `<h1>` from "Shared Knowledge" to "Library"
3. **`shared-knowledge/page.tsx`** — update metadata title if present
4. **`ToolsClient.tsx`** — change `<h1>` from "Tools" to "Dependencies", update subtitle to "CLI tools and packages available to agent skills."
5. **`tools/page.tsx`** — update metadata title if present

### Phase C: Skill chips enhancement (AI-107)

6. **`SkillsClient.tsx`** — on the collapsed skill row (summary line), add a small badge showing tool dependency count (e.g., "3 deps") next to the scope badge when `tools.length > 0`
7. **`SkillsClient.tsx`** — for `host_docker` and `vps_system` scope badges, prepend a warning triangle (lucide `AlertTriangle` icon, 12px) inside the badge to visually signal elevated danger

### Phase D: Test updates

8. Update existing tests that assert on old labels ("Shared Knowledge", "Tools") to use new labels ("Library", "Dependencies")
9. Add T1-T8 new assertions across existing test files
10. Verify all Sidebar tests still pass (nav item names changed)

---

## 5. Verification Matrix

| ID | Check | Command | Expected |
|---|---|---|---|
| V1 | Sidebar tests pass | `cd services/ui && npx vitest run Sidebar` | All pass |
| V2 | MobileDrawer tests pass | `cd services/ui && npx vitest run MobileDrawer` | All pass |
| V3 | SharedKnowledgeClient tests pass | `cd services/ui && npx vitest run SharedKnowledgeClient` | All pass |
| V4 | ToolsClient tests pass | `cd services/ui && npx vitest run ToolsClient` | All pass |
| V5 | SkillsClient tests pass | `cd services/ui && npx vitest run SkillsClient` | All pass |
| V6 | Full UI suite passes | `cd services/ui && npx vitest run` | All 528+ pass |

---

## 6. CI / Drift Gates

- **Existing gates preserved:** Vitest (UI), Jest (API)
- **No new CI job:** existing test suites cover all changes
- **Drift risk:** If new nav items are added to Harness, they should follow the new grouping pattern. No automated enforcement needed — nav-items.ts is a single file.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Test assertions on old labels break | Certain | Low | Systematic find-and-replace in test files |
| Sidebar test checks "shared knowledge" link name | Certain | Low | Update to "library" |
| Knowledge page route confusion (nav moved but URL stays) | Low | Low | URL unchanged — no user-facing breakage |
| Tool dependency count badge clutters skill row | Low | Low | Only shown when count > 0; small muted badge |
| MobileDrawer tests reference old nav labels | Likely | Low | Update alongside Sidebar tests |

---

## 8. Definition of Done

- [ ] Nav shows: Home, Dashboard, Agents, Chat, Knowledge, Harness(Connections/Models/Skills/Dependencies/Usage/Library), Docs, Admin
- [ ] "Shared Knowledge" renamed to "Library" in nav + page heading (T1, T4)
- [ ] "Tools" renamed to "Dependencies" in nav + page heading + subtitle (T2, T5, T6)
- [ ] Knowledge appears as top-level nav link (T3)
- [ ] Skill cards show tool dependency count on summary row (T7)
- [ ] Elevated scope badges show warning indicator (T8)
- [ ] All existing tests updated and passing (V1-V6)
- [ ] No route/URL changes
- [ ] No API/backend changes

---

## 9. Stop Conditions

**Stop if:**
- Any rename requires API route changes (shouldn't — routes are `/harness/*` not `/tools/*`)
- Knowledge page breaks when nav position changes (shouldn't — it's just a link, not a route change)
- Test count drops (indicates missed test updates)

**Out of scope (future work):**
- Route restructuring (moving `/harness/knowledge` to `/knowledge`)
- Splitting Harness into sub-groups (e.g., "Infrastructure" vs "AI")
- New harness pages
- Backend API renames to match UI terminology

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

## Critical Files

| File | Change |
|---|---|
| `services/ui/src/components/nav-items.ts` | Restructure nav: move Knowledge top-level, rename Tools→Dependencies, rename Shared Knowledge→Library |
| `services/ui/src/app/harness/tools/ToolsClient.tsx` | Heading "Dependencies", new subtitle |
| `services/ui/src/app/harness/shared-knowledge/SharedKnowledgeClient.tsx` | Heading "Library" |
| `services/ui/src/app/harness/skills/SkillsClient.tsx` | Tool count badge, elevated scope warning icon |
| `services/ui/src/__tests__/Sidebar.test.tsx` | Updated nav assertions (T1-T3) |
| `services/ui/src/__tests__/MobileDrawer.test.tsx` | Updated nav label assertions |
| `services/ui/src/__tests__/ToolsClient.test.tsx` | Updated heading assertion (T5-T6) |
| `services/ui/src/__tests__/SharedKnowledgeClient.test.tsx` | Updated heading assertion (T4) |
| `services/ui/src/__tests__/SkillsClient.test.tsx` | Tool count badge + warning icon tests (T7-T8) |
