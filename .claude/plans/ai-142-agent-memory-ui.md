# AI-142: AKM Productization — Agent Memory UI Surface

**Linear:** AI-142 | **Status:** Planning | **Date:** 2026-04-04

## Context

The Knowledge tab on agent detail already exists (AgentDetailClient.tsx lines 773-935) with entry list, search, type badges, and content viewer — but it's ~160 lines of inline code in a 950+ line component, named "Knowledge" (generic), and missing type filter buttons, entry count stats, and journal-specific UX.

This PR extracts the memory view into a dedicated `AgentMemory` component, renames the tab from "Knowledge" to "Memory", adds type filter tabs (like the harness Knowledge page), entry count summary, and journal timeline view.

---

## 1. Goal / Signal

After this lands:
- Agent detail tab labeled "Memory" (was "Knowledge") with dedicated `AgentMemory` component
- Type filter buttons: All, Note, Plan, Decision, Journal, Research — filter the entry list
- Entry count summary line: "42 entries (12 notes, 8 plans, 5 decisions, 10 journals, 7 research)"
- Journal entries show as a timeline with date grouping
- Search works within the filtered view
- AgentDetailClient.tsx reduced by ~150 lines (extracted to component)
- All existing knowledge functionality preserved

---

## 2. Scope

**In scope:**
- Extract `AgentMemory` component from AgentDetailClient.tsx inline code
- Rename tab from "Knowledge" to "Memory" in tab bar
- Add type filter buttons (reuse `ENTRY_TYPES` + `typeBadgeColor` from KnowledgeClient)
- Add entry count summary with per-type breakdown
- Journal timeline: group journal entries by date, show as dated sections
- 6 vitest tests for AgentMemory component

**Out of scope:**
- API changes (all endpoints exist: `/api/knowledge/entries`, `/api/knowledge/search`, `/api/knowledge/entries/:agent/:path`)
- New entry types or schema changes
- Entry creation/editing from the UI (agents create entries via AKM API)
- Changes to the harness Knowledge page (separate page, untouched)
- Changes to KnowledgeClient.tsx

---

## 3. TDD Matrix

| # | Requirement | Test Name | Type | File |
|---|---|---|---|---|
| T1 | Renders entry list | `AgentMemory renders entry list` | vitest | AgentMemory.test.tsx |
| T2 | Type filter buttons filter entries | `AgentMemory filters entries by type` | vitest | AgentMemory.test.tsx |
| T3 | Entry count summary shows | `AgentMemory shows entry count summary` | vitest | AgentMemory.test.tsx |
| T4 | Search returns results | `AgentMemory search shows results` | vitest | AgentMemory.test.tsx |
| T5 | Click entry shows content | `AgentMemory click entry loads content` | vitest | AgentMemory.test.tsx |
| T6 | Empty state renders | `AgentMemory shows empty state` | vitest | AgentMemory.test.tsx |

---

## 4. Implementation Steps

### Phase A: Extract AgentMemory component

1. Create `services/ui/src/app/agents/[id]/AgentMemory.tsx`:
   - Props: `agentId: string` (the agent_id slug, not UUID)
   - Internal state: entries, search, selectedEntry, selectedEntryContent, typeFilter, loading
   - Lazy-load entries from `/api/knowledge/entries?agent_id={agentId}` on mount
   - Type filter: `All | note | plan | decision | journal | research` buttons
   - Entry count summary: computed from entries array
   - Entry list: filtered by selected type, each clickable to load content
   - Entry detail: full content in `<pre>` with back button
   - Search: form input → `/api/knowledge/search?q={q}&agent_id={agentId}`
   - Reuse `typeBadgeColor` function from KnowledgeClient pattern

### Phase B: Update AgentDetailClient.tsx

2. Replace the `knowledge` tab ID with `memory` in `TabId` union type
3. Replace inline knowledge rendering (lines 773-935) with `<AgentMemory agentId={agent.agent_id} />`
4. Remove knowledge-related state variables from AgentDetailClient (entries, search, selectedEntry, etc.)
5. Update tab button label from "Knowledge" to "Memory"

### Phase C: Tests

6. Create `services/ui/src/__tests__/AgentMemory.test.tsx` with T1-T6
   - Mock global fetch for entries and search endpoints
   - Verify entry list renders, type filters work, search returns results, click loads content

---

## 5. Verification Matrix

| ID | Check | Command | Expected |
|---|---|---|---|
| V1 | AgentMemory tests pass | `cd services/ui && npx vitest run AgentMemory` | 6 tests green |
| V2 | Existing agent detail tests pass | `cd services/ui && npx vitest run AgentDetailClient` | All pass |
| V3 | Full UI suite | `cd services/ui && npx vitest run` | All 568+ pass |

---

## 6. CI / Drift Gates

- **Existing gates preserved:** Vitest (UI), Jest (API)
- **No API changes:** zero drift risk
- **Drift risk:** If knowledge API response shape changes, AgentMemory type interfaces must be updated. Tests validate data rendering.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Extraction breaks existing knowledge display | Low | High | Tests verify entry list, search, detail view all work |
| Tab rename breaks deep links or tests | Low | Low | No URL-based tab selection exists (state is component-local) |
| AgentDetailClient test references "knowledge" | Medium | Low | Update any test assertions on tab names |

---

## 8. Definition of Done

- [ ] "Memory" tab on agent detail page (was "Knowledge")
- [ ] Type filter buttons work (T2)
- [ ] Entry count summary visible (T3)
- [ ] Search works (T4)
- [ ] Entry content viewer works (T5)
- [ ] Empty state renders (T6)
- [ ] AgentDetailClient.tsx reduced by ~150 lines
- [ ] 6 new vitest tests pass (V1)
- [ ] No existing test regressions (V2, V3)
- [ ] No API changes

---

## 9. Stop Conditions

**Stop if:**
- Extraction causes prop-drilling deeper than 2 levels (shouldn't — AgentMemory is self-contained)
- Journal timeline grouping is too complex for this PR (defer to follow-up)
- Any existing AgentDetailClient tests break in ways that require large test rewrites

**Out of scope:**
- Entry creation/editing from UI
- Entry deletion from UI
- Bulk operations
- Export/import
- Cross-agent knowledge search

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
| `services/ui/src/app/agents/[id]/AgentMemory.tsx` | NEW — extracted memory component with type filters + count summary |
| `services/ui/src/app/agents/[id]/AgentDetailClient.tsx` | Tab rename, replace inline code with `<AgentMemory>` |
| `services/ui/src/__tests__/AgentMemory.test.tsx` | NEW — 6 tests |
