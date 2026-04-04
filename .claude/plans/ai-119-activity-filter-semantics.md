# AI-119: Fix Activity Filter Semantics for Runtime vs Inference Cards

**Linear:** AI-119 | **Status:** In Progress | **Date:** 2026-04-04

## Context

The Activity tab on agent detail pages shows a live event stream with filter buttons: All, Shell, Filesystem, Runtime, Inference. The Runtime filter uses `e.tool !== 'inference'` (negation) while others use `e.tool === filter.toLowerCase()` (direct match). The UI filter logic is correct — all 10 RF tests pass.

The actual problem is twofold:

1. **SSE path delivers events unsorted.** The API events endpoint (`GET /agents/:id/events?follow=true`) has three phases: (a) inference backfill from DB, (b) container `tail -f` for shell/fs/runtime events, (c) inference poll every 3s. These produce events in arrival order, not timestamp order. The one-shot path sorts by `(timestamp, id)` — the SSE path does not.

2. **Unsorted events break grouping under the Runtime filter.** The grouping algorithm's Phase 2 (Signal B) requires adjacent inference→runtime events within 3000ms. When SSE delivers inference backfill first, then container events stream in separately, inference and runtime events that should be adjacent are not — grouping fails, and the Runtime filter shows ungrouped runtime events without their inference counterparts (which are correctly hidden), losing the work-step context.

The fix: sort events client-side on receipt so the filter and grouping operate on a deterministic, timestamp-ordered array regardless of SSE delivery order.

---

## 1. Goal / Signal

After this lands:
- Events in the Activity tab are always displayed in chronological order regardless of SSE delivery order
- Runtime filter shows correctly grouped work-step events (inference excluded, but grouping computed from the full sorted set before filtering)
- Inference filter shows inference events in correct chronological position
- Grouping algorithm produces identical results whether events arrive via one-shot or SSE

---

## 2. Scope

**In scope:**
- Client-side sort of events array by `(timestamp, id)` on SSE receipt in `EventTimeline.tsx`
- Fix grouping computation: compute groups on **all events** first, then apply filter — so Runtime filter preserves group structure minus inference cards
- 6 new vitest tests to lock the sort + group-before-filter behavior
- 2 new API tests to document SSE delivery order expectations

**Out of scope:**
- Server-side SSE sorting (events stream from multiple async sources — sorting would require buffering, adding latency)
- Changes to the one-shot path (already sorted correctly)
- Changes to `EventCard.tsx` rendering
- Changes to the API events endpoint
- Changes to the grouping algorithm itself (it's correct — just needs sorted input and pre-filter computation)

---

## 3. TDD Matrix

| # | Requirement | Test Name | Type | File |
|---|---|---|---|---|
| T1 | Events sorted by timestamp on SSE receipt | `events are sorted by timestamp regardless of SSE delivery order` | vitest | EventTimeline.test.tsx |
| T2 | Events with same timestamp sorted by id | `same-timestamp events sorted by id as tiebreaker` | vitest | EventTimeline.test.tsx |
| T3 | Runtime filter preserves group structure | `Runtime filter shows grouped runtime events without inference` | vitest | EventTimeline.test.tsx |
| T4 | Late-arriving inference event inserted in correct position | `late SSE inference event sorted into correct chronological position` | vitest | EventTimeline.test.tsx |
| T5 | Group computed before filter — Runtime filter gets group spine | `group spine visible under Runtime filter for work-step group` | vitest | EventTimeline.test.tsx |
| T6 | Inference filter shows events in timestamp order after sort | `Inference filter shows chronologically sorted inference events` | vitest | EventTimeline.test.tsx |
| T7 | SSE backfill inference arrives before container events | `SSE backfill delivers inference events before container events` | jest | routes-agents-events.test.ts |
| T8 | SSE poll inference arrives interleaved with container events | `SSE inference poll events arrive after initial container events` | jest | routes-agents-events.test.ts |

---

## 4. Implementation Steps

### Phase A: Red — Write failing tests

1. Add T1-T6 vitest tests in `EventTimeline.test.tsx` under a new `EventTimeline — sort + group-before-filter` describe block. These send SSE events in deliberately wrong order (inference before container, out-of-timestamp-order) and assert:
   - T1: Rendered cards appear in chronological order
   - T2: Same-timestamp events appear in id-lexicographic order
   - T3: Under Runtime filter, grouped runtime events still show group spine
   - T4: A late-arriving inference SSE message appears in correct chronological position (not appended at end)
   - T5: Group spine is visible under Runtime filter for a work_id-linked group
   - T6: Inference filter shows events sorted oldest→newest

2. Add T7-T8 jest tests in `routes-agents-events.test.ts` to document the SSE delivery order (these should pass already — they document existing behavior, not fix it).

### Phase B: Green — Fix EventTimeline.tsx

3. **Sort on insert.** In the `es.onmessage` handler (line 238-247), replace the naive append:
   ```typescript
   // Before: const next = [...prev, event]
   // After: binary-insert by (timestamp, id) to maintain sorted order
   ```
   Use insertion sort (binary search for position) since events arrive mostly in order — O(log n) per insert vs O(n log n) full re-sort.

4. **Compute groups before filtering.** Change the filter/group computation (lines 271-279):
   ```typescript
   // Before:
   // const filtered = filter === 'All' ? events : ...
   // const groups = computeGroups(filtered)

   // After:
   // const groups = computeGroups(events)  // groups computed on ALL events
   // const filtered = filter === 'All' ? events : ...
   // const segments = buildSegments(filtered, groups)  // segments built from filtered + full groups
   ```
   This ensures a work_id group spanning inference+runtime events still has its group ID when we filter to Runtime-only events. The group spine and status badge will appear even though inference cards are hidden.

### Phase C: Refactor

5. Extract the sorted-insert helper as a named function (`insertSorted`) for readability and testability.
6. Verify all 10 existing RF tests still pass (they should — the filter predicate is unchanged).

---

## 5. Verification Matrix

| ID | Check | Command | Expected |
|---|---|---|---|
| V1 | Existing RF1-RF10 tests pass | `cd services/ui && npx vitest run EventTimeline` | All pass |
| V2 | Existing G1-G7 + N1-N9 grouping tests pass | Same as V1 | All pass |
| V3 | New T1-T6 tests pass | Same as V1 | 6 new tests green |
| V4 | Full UI suite passes | `cd services/ui && npx vitest run` | All 512+ pass |
| V5 | API events tests pass | `cd services/api && npm test -- --testPathPattern routes-agents-events` | All pass including T7-T8 |
| V6 | Full API test suite | `cd services/api && npm test` | All pass |

---

## 6. CI / Drift Gates

- **Existing gates preserved:** Vitest (UI), Jest (API), OpenAPI drift, shellcheck, compose validation
- **No new CI job:** existing test suites cover via 8 new test cases
- **Drift risk:** If the SSE delivery order changes in the API (e.g., events become pre-sorted), the client-side sort becomes a no-op — harmless. The tests verify correct output regardless of input order, so they remain valid.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Binary insert has off-by-one on boundary timestamps | Medium | Low | T2 tests same-timestamp tiebreaker explicitly |
| Group-before-filter changes Runtime display | Low | Medium | RF1-RF10 tests locked; T3/T5 verify group spine visible |
| Performance: sort on every SSE event at 500-event cap | Very Low | Low | Binary insert is O(log n), MAX_EVENTS=500 cap bounds array size |
| Existing grouping edge cases break | Low | Medium | 16 existing grouping tests (G1-G7, N1-N9) run as regression suite |
| Late inference poll events cause visual reflow | Low | Low | Insert-in-place is less jarring than append-then-re-sort — cards don't jump |

---

## 8. Definition of Done

- [ ] Events displayed in chronological order under all filters (V1-V3)
- [ ] Runtime filter preserves group spine for mixed inference/runtime groups (T3, T5)
- [ ] Inference filter shows chronologically sorted events (T6)
- [ ] Late SSE events insert in correct position (T4)
- [ ] All 10 existing RF tests pass (V1)
- [ ] All 16 existing grouping tests pass (V2)
- [ ] 6 new UI tests pass (V3)
- [ ] 2 new API tests pass (V5)
- [ ] Full UI + API suites green (V4, V6)
- [ ] No changes to API events endpoint
- [ ] No changes to EventCard.tsx

---

## 9. Stop Conditions

**Stop if:**
- Binary insert causes visible rendering jank at 500 events (profile first, fall back to batched re-sort)
- Group-before-filter produces confusing UX where orphaned group spines appear with no cards (would mean all events in a group were filtered out — investigate edge case)
- The SSE delivery order turns out to already be deterministic (would make the client sort unnecessary — verify with T7/T8 first)

**Out of scope (future work):**
- Server-side SSE event buffering and sorting
- Virtual scrolling for >500 events
- Filter persistence across tab switches
- Event deduplication (handled by SSE id tracking, not filter layer)

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
| `services/ui/src/app/agents/[id]/EventTimeline.tsx` | Sorted insert in SSE handler, group-before-filter computation |
| `services/ui/src/__tests__/EventTimeline.test.tsx` | 6 new tests (T1-T6) |
| `services/api/src/__tests__/routes-agents-events.test.ts` | 2 new tests (T7-T8, documenting SSE delivery order) |
