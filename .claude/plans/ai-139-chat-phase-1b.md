# AI-139: Chat Phase 1B — Group Thread UI Completion

**Linear:** AI-139 | **Status:** Planning | **Date:** 2026-04-04

## Context

Phase 1 (PR #245) shipped direct threads, message persistence, SSE streaming, and callback-based agent responses. Phase 1B was defined as "group threads, multi-agent dispatch, Live Session pane" — but architectural research reveals the API and most UI are **already complete** from incremental work across PRs #245–#271.

**What already works:**
- API: all 9 chat endpoints fully support group threads (creation with `agent_ids[]`, multi-agent dispatch, @mention routing, participant add/remove, per-agent concurrency guard, event stream filtering, a2a orchestration)
- UI: group creation (NewThreadDialog multi-select), group display (agent color badges, agent name attribution), session pane (events from all thread agents), cancel button, thread list (group indicator + agent names), chain provenance annotations

**What's missing (2 gaps):**
1. **@-mention input UX** — placeholder text says "@name to target one" but input has no autocomplete, highlighting, or feedback. API accepts raw @mentions, but users get no guidance.
2. **Participant management UI** — API endpoint `PUT /threads/:id/participants` exists and works. No UI to call it. Users cannot add/remove agents from existing group threads.

---

## 1. Goal / Signal

After this lands:
- Users can type `@` in the chat input and see an autocomplete dropdown of thread participant agents
- Selecting an autocomplete suggestion inserts `@agent-slug ` into the input
- Users can open a "Manage Participants" panel from the group thread header to add/remove agents
- Adding an agent calls `PUT /threads/:id/participants` with `{add: [uuid]}`
- Removing an agent calls `PUT /threads/:id/participants` with `{remove: [uuid]}` and shows confirmation
- All existing group thread functionality (creation, dispatch, SSE, badges, chain provenance) is unchanged

---

## 2. Scope

**In scope:**
- `MentionInput` component: `@`-triggered autocomplete dropdown in chat input, inserts `@slug ` on selection
- `ParticipantPanel` component: slide-out or modal panel to add/remove agents from group thread
- Integration into `ChatView.tsx`: replace plain textarea with MentionInput, add participant button to header
- Agent picker within ParticipantPanel: reuse pattern from NewThreadDialog (fetch `/api/agents`, checkbox list)
- 8 vitest tests for MentionInput + ParticipantPanel
- 3 API tests for participant management edge cases (optional — API is already well-tested)

**Out of scope:**
- API changes (all endpoints complete)
- Backend @mention parsing changes (parseMentions in chat.ts is unchanged)
- Agentbox changes (agentbox processes one work item per placeholder, unchanged)
- Changes to NewThreadDialog (already supports multi-select)
- Changes to ChatMessage rendering (already shows agent badges + chain provenance)
- Changes to SessionPane (already shows all thread events)
- Agent-to-agent @mention orchestration (AI-138, already merged)
- Real-time participant presence indicators (future)
- @mention in agent responses displayed as links (future)

---

## 3. TDD Matrix

| # | Requirement | Test Name | Type | File |
|---|---|---|---|---|
| T1 | `@` triggers autocomplete dropdown | `MentionInput shows autocomplete on @ trigger` | vitest | MentionInput.test.tsx |
| T2 | Selecting agent inserts @slug into input | `MentionInput inserts @slug on selection` | vitest | MentionInput.test.tsx |
| T3 | Autocomplete filters by typed prefix | `MentionInput filters agents by prefix after @` | vitest | MentionInput.test.tsx |
| T4 | Escape closes autocomplete | `MentionInput closes autocomplete on Escape` | vitest | MentionInput.test.tsx |
| T5 | Submit sends full text including @mention | `MentionInput submits message with @mention intact` | vitest | MentionInput.test.tsx |
| T6 | ParticipantPanel renders current participants | `ParticipantPanel shows current thread agents` | vitest | ParticipantPanel.test.tsx |
| T7 | ParticipantPanel add agent calls API | `ParticipantPanel add agent calls PUT /participants` | vitest | ParticipantPanel.test.tsx |
| T8 | ParticipantPanel remove agent with confirmation | `ParticipantPanel remove agent requires confirmation` | vitest | ParticipantPanel.test.tsx |

---

## 4. Implementation Steps

### Phase A: MentionInput component

1. Create `services/ui/src/app/chat/MentionInput.tsx`:
   - Props: `agents: ChatAgent[]`, `value: string`, `onChange: (value: string) => void`, `onSubmit: () => void`, `disabled: boolean`, `placeholder: string`
   - State: `showAutocomplete: boolean`, `autocompleteIndex: number`, `filterText: string`
   - On `@` typed: set `showAutocomplete = true`, track cursor position
   - On typing after `@`: filter agents by `agent_id` prefix match
   - On ArrowDown/ArrowUp: navigate autocomplete list
   - On Enter in autocomplete: insert `@{agent_id} ` at cursor, close autocomplete
   - On Escape: close autocomplete
   - On Enter without autocomplete: call `onSubmit()`
   - Render: `<textarea>` with absolute-positioned dropdown below cursor

2. Update `ChatView.tsx`:
   - Replace the plain `<textarea>` (lines ~235-250) with `<MentionInput>`
   - Pass `agents` prop from thread participants
   - Keep same `handleSend` logic — message text already includes `@slug` which API parses

### Phase B: ParticipantPanel component

3. Create `services/ui/src/app/chat/ParticipantPanel.tsx`:
   - Props: `threadId: string`, `currentAgents: ChatAgent[]`, `onUpdated: () => void`, `onClose: () => void`
   - State: `availableAgents: Agent[]` (fetched from `/api/agents`), `loading: boolean`, `adding: string | null`
   - Current participants section: list with name + status badge + "Remove" button
   - Remove flow: `confirm()` → `PUT /api/chat/{threadId}/participants` with `{remove: [uuid]}`
   - Add section: agent picker (filtered to exclude current participants, exclude stopped agents)
   - Add flow: click agent → `PUT /api/chat/{threadId}/participants` with `{add: [uuid]}`
   - Max 8 enforcement: disable add button when at limit
   - On success: call `onUpdated()` to refresh thread data

4. Update `ChatView.tsx`:
   - Add "Manage" button (Users icon) to group thread header, next to SessionPane toggle
   - State: `participantPanelOpen: boolean`
   - Render `<ParticipantPanel>` when open, passing current agents + threadId
   - On `onUpdated`: re-fetch thread data (call `onThreadUpdated()`)

### Phase C: Tests

5. Create `services/ui/src/__tests__/MentionInput.test.tsx` with T1-T5.
6. Create `services/ui/src/__tests__/ParticipantPanel.test.tsx` with T6-T8.

---

## 5. Verification Matrix

| ID | Check | Command | Expected |
|---|---|---|---|
| V1 | MentionInput tests pass | `cd services/ui && npx vitest run MentionInput` | 5 tests green |
| V2 | ParticipantPanel tests pass | `cd services/ui && npx vitest run ParticipantPanel` | 3 tests green |
| V3 | Existing chat UI tests pass | `cd services/ui && npx vitest run ChatMessage ChatView ThreadList` | All pass |
| V4 | Full UI suite | `cd services/ui && npx vitest run` | All 560+ pass |
| V5 | API chat tests unchanged | `cd services/api && npm test -- --testPathPattern routes-chat` | All 75+ pass |

---

## 6. CI / Drift Gates

- **Existing gates preserved:** Vitest (UI), Jest (API), OpenAPI drift, compose validation
- **No new CI job:** existing vitest suite covers 8 new tests
- **No API changes:** zero drift risk on backend
- **Drift risk:** If `ChatAgent` interface changes, MentionInput and ParticipantPanel must be updated. The vitest tests catch this via type-checking at compile time.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| @mention autocomplete position misaligned on mobile | Medium | Low | Absolute positioning relative to textarea, not viewport. Test at sm breakpoint. |
| Autocomplete flickers on rapid typing | Low | Low | Debounce filter by 100ms. Close immediately on non-@ character. |
| Participant removal mid-conversation loses context | Low | Medium | API already marks pending messages as error on removal (chat.ts lines 711-718). UI shows confirmation dialog. |
| Max 8 agent limit not enforced in add flow | Low | High | Check `currentAgents.length >= 8` before enabling add button. API enforces server-side as backup. |
| Elevated scope agent added by non-admin | Low | High | API returns 403 for elevated agents. UI shows error toast. No client-side bypass possible. |

---

## 8. Definition of Done

- [ ] `@` in chat input shows autocomplete dropdown with thread agents (T1)
- [ ] Selecting agent inserts `@slug ` into input text (T2)
- [ ] Autocomplete filters by prefix (T3)
- [ ] Escape closes autocomplete (T4)
- [ ] Message with @mention sends correctly (T5)
- [ ] Group thread header shows "Manage" button (participants icon)
- [ ] ParticipantPanel lists current agents with remove option (T6)
- [ ] Add agent flow calls API and refreshes thread (T7)
- [ ] Remove agent requires confirmation (T8)
- [ ] 8 new vitest tests pass (V1, V2)
- [ ] No existing test regressions (V3, V4, V5)
- [ ] No API changes
- [ ] No agentbox changes

---

## 9. Stop Conditions

**Stop if:**
- MentionInput requires a rich text editor library (should be achievable with plain textarea + absolute dropdown)
- Participant add/remove causes SSE stream disconnection (shouldn't — SSE cursor is sequence-based, not participant-based)
- Any elevated scope agent becomes addable by non-admin through the UI (security boundary violation — API guards this, but verify)

**Out of scope (future work):**
- @mention syntax highlighting in input (colored @slug text — requires contenteditable or rich editor)
- Real-time participant presence (online/typing indicators)
- @mention rendering as links in message bubbles
- Drag-and-drop agent reordering in participant panel
- Thread-level notification preferences per agent
- Cross-thread @mentions

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
| `services/ui/src/app/chat/MentionInput.tsx` | NEW — @-triggered autocomplete input |
| `services/ui/src/app/chat/ParticipantPanel.tsx` | NEW — add/remove agents panel |
| `services/ui/src/app/chat/ChatView.tsx` | Replace textarea with MentionInput, add participant button |
| `services/ui/src/__tests__/MentionInput.test.tsx` | NEW — 5 tests (T1-T5) |
| `services/ui/src/__tests__/ParticipantPanel.test.tsx` | NEW — 3 tests (T6-T8) |

## Reusable Existing Code

| What | Where |
|---|---|
| `ChatAgent` interface | `ChatLayout.tsx:10` — id, agent_id, name, status |
| Agent picker pattern | `NewThreadDialog.tsx:113-155` — checkbox list with status badges |
| `parseMentions(content)` | `chat.ts:124` — API-side @mention parser (unchanged) |
| `PUT /threads/:id/participants` | `chat.ts:660-744` — add/remove with all guards |
| Agent fetch | `/api/agents` proxy → API GET /agents (user-scoped) |
