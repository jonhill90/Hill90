# Agent Task Board — Design Document

**Linear:** AI-112 | **Status:** Design | **Date:** 2026-04-04

## 1. Problem

Agent work is currently invisible between "started" and "done." Events stream operational telemetry (shell commands, inferences) but there is no structured view of *what* an agent is working on, what's queued, or what's blocked. Humans must read chat threads or journal entries to piece together agent progress.

The platform needs a Kanban-style task board that makes agent work legible at a glance.

## 2. Goals

1. Give each agent a structured backlog of tasks with Kanban state progression.
2. Let agents self-report task state via their API (create, update, transition).
3. Let humans observe and manage tasks via a board UI.
4. Connect tasks to existing entities (knowledge plans, chat threads).
5. Enable cross-agent visibility — see all active tasks in one view.

## 3. Non-Goals (MVP)

- Drag-and-drop reordering (future — add `dnd-kit` when needed).
- Cross-agent task dependencies or blocking relationships.
- Time tracking, estimates, or velocity metrics.
- Automated state transitions from events (future: `work_completed` → mark task done).
- Task assignment between agents.

## 4. Data Model

### 4.1 New Table: `agent_tasks`

```sql
CREATE TABLE agent_tasks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    TEXT NOT NULL,
    title       VARCHAR(255) NOT NULL,
    description TEXT DEFAULT '',
    status      VARCHAR(20) NOT NULL DEFAULT 'backlog'
                CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled')),
    priority    SMALLINT NOT NULL DEFAULT 3
                CHECK (priority BETWEEN 1 AND 4),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    plan_id     UUID REFERENCES knowledge_entries(id) ON DELETE SET NULL,
    thread_id   UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
    tags        TEXT[] DEFAULT '{}',
    created_by  VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_tasks_agent_status ON agent_tasks (agent_id, status);
CREATE INDEX idx_agent_tasks_status ON agent_tasks (status) WHERE status NOT IN ('done', 'cancelled');
```

**Status flow:**

```
backlog → todo → in_progress → review → done
                     ↓                    ↑
                     └──────────────────→ cancelled
```

Any forward transition is valid. Backward transitions are allowed (e.g., review → in_progress for rework). Only `done` and `cancelled` are terminal.

**Priority values** (mirrors Linear convention):
- 1 = Urgent
- 2 = High
- 3 = Medium (default)
- 4 = Low

### 4.2 Wire `chat_threads.task_id`

The existing `chat_threads` table already has `task_id UUID DEFAULT NULL`. Once `agent_tasks` exists, add the FK constraint:

```sql
ALTER TABLE chat_threads
    ADD CONSTRAINT fk_chat_threads_task
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE SET NULL;
```

This enables task-scoped conversations — a thread can be linked to a task, and the board can show "2 messages" on a task card.

### 4.3 Progression Integration

The agent progression system (`docs/architecture/agent-progression-system.md`) already defines a `tasks_completed` stat. With `agent_tasks`, this becomes a real counter:

```sql
SELECT COUNT(*) FROM agent_tasks WHERE agent_id = $1 AND status = 'done';
```

## 5. API Design

### 5.1 Agent-Facing Endpoints (Ed25519 JWT Auth)

Added to the knowledge service alongside existing entry routes:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tasks` | Create a task |
| `GET` | `/api/v1/tasks` | List own tasks (optional `?status=` filter) |
| `GET` | `/api/v1/tasks/:id` | Get task detail |
| `PUT` | `/api/v1/tasks/:id` | Update task (title, description, status, priority, tags) |
| `PATCH` | `/api/v1/tasks/:id/transition` | Transition status (`{ status: "in_progress" }`) |

Agents are scoped to their own tasks (`WHERE agent_id = claims.sub`).

**Create request body:**
```json
{
  "title": "Analyze deployment logs",
  "description": "Check for error patterns in last 24h of deploy logs",
  "priority": 2,
  "plan_id": "optional-uuid-of-related-plan",
  "tags": ["ops", "monitoring"]
}
```

**Transition request body:**
```json
{
  "status": "in_progress"
}
```

### 5.2 UI-Facing Endpoints (Keycloak JWT + Role Auth)

Added to the API service, proxied through to knowledge service:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks` | List tasks (optional `?agent_id=`, `?status=`) |
| `GET` | `/tasks/:id` | Get task detail |
| `PUT` | `/tasks/:id` | Update task (human can edit title, description, priority, tags) |
| `PATCH` | `/tasks/:id/transition` | Transition status |
| `POST` | `/tasks` | Create task for an agent (human-initiated) |
| `DELETE` | `/tasks/:id` | Cancel task (sets status to cancelled) |

**Ownership model:** Admin sees all tasks. Regular users see tasks for agents they own (same `scopeToOwner` pattern as agents).

### 5.3 API Proxy Pattern

Follow the established `akm-proxy.ts` / `shared-knowledge-proxy.ts` pattern:

```
services/api/src/services/task-proxy.ts    → HTTP client for knowledge:8002/internal/admin/tasks/*
services/api/src/routes/tasks.ts           → Express routes with ownership scoping
```

Internal knowledge service routes:
```
/internal/admin/tasks                      → List/create (service token auth)
/internal/admin/tasks/:id                  → Get/update (service token auth)
/internal/admin/tasks/:id/transition       → Status transition (service token auth)
```

## 6. UI Design

### 6.1 Page Location

**Option A (recommended):** Top-level `/tasks` page accessible from sidebar nav.
- Visible to all authenticated users.
- Shows a cross-agent board filtered by the user's agents.
- Add to `nav-items.ts`: `{ href: '/tasks', label: 'Tasks', icon: CheckSquare }`.

**Option B:** Agent detail tab (like Notebook/Memory).
- Per-agent view only. Requires switching between agents to see all work.
- Less useful for oversight of multiple agents.

**Recommendation:** Option A as primary view, with a "Tasks" count badge on the agent detail page that links to the board filtered by that agent.

### 6.2 Board Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tasks                                              [+ New Task]    │
│  ┌──────────┐  Agent: [All ▾]  Priority: [All ▾]                   │
│  │ Board │List│                                                     │
│  └──────────┘                                                       │
├────────────┬────────────┬────────────┬────────────┬────────────────┤
│  Backlog   │  To Do     │ In Progress│  Review    │  Done          │
│  (3)       │  (2)       │  (1)       │  (1)       │  (4)          │
├────────────┼────────────┼────────────┼────────────┼────────────────┤
│ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │ ┌────────┐   │
│ │Task    │ │ │Task    │ │ │Task    │ │ │Task    │ │ │Task    │   │
│ │ title  │ │ │ title  │ │ │ title  │ │ │ title  │ │ │ title  │   │
│ │ P2     │ │ │ agent  │ │ │ agent  │ │ │ agent  │ │ │ done   │   │
│ │ agent  │ │ │ 2 msgs │ │ │ plan   │ │ │        │ │ │        │   │
│ └────────┘ │ └────────┘ │ └────────┘ │ └────────┘ │ └────────┘   │
│ ┌────────┐ │ ┌────────┐ │            │            │ ┌────────┐   │
│ │Task    │ │ │Task    │ │            │            │ │Task    │   │
│ │ title  │ │ │ title  │ │            │            │ │ title  │   │
│ └────────┘ │ └────────┘ │            │            │ └────────┘   │
└────────────┴────────────┴────────────┴────────────┴────────────────┘
```

### 6.3 Task Card

Each card shows:
- **Title** (truncated to 2 lines)
- **Priority badge** (color-coded: urgent=red, high=amber, medium=default, low=muted)
- **Agent name** (small badge, links to agent detail)
- **Linked entities** (plan icon if `plan_id`, chat icon with count if `thread_id`)
- **Tags** (first 2, "+N more" overflow)
- **Updated timestamp** (relative: "2h ago")

Card styling follows existing patterns:
```
rounded-lg border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors
```

### 6.4 Task Detail Panel

Clicking a card opens a slide-over panel (right side) or inline expansion:
- Full title (editable)
- Description (markdown rendered, editable)
- Status dropdown with forward/backward transitions
- Priority selector
- Linked plan (clickable to agent Memory tab)
- Linked thread (clickable to Chat)
- Tags (editable)
- Created/updated timestamps
- Created by (human or agent)

### 6.5 Board vs List Toggle

Two view modes (tab toggle, similar to SharedKnowledgeClient):
- **Board view:** Kanban columns as described above.
- **List view:** Table with sortable columns (title, agent, status, priority, updated).

### 6.6 Filters

- **Agent filter:** Dropdown of user's agents (admin sees all).
- **Priority filter:** All / Urgent / High / Medium / Low.
- **Status filter:** Active (excludes done/cancelled) or All.
- Filters are URL query params for shareability.

## 7. Agent Integration

### 7.1 How Agents Use Tasks

Agents manage their own task lifecycle via the `/api/v1/tasks` endpoints:

```
Agent receives work instruction (chat message)
  → POST /api/v1/tasks { title: "...", status: "in_progress" }
  → Agent works (shell, inference, file ops)
  → PUT /api/v1/tasks/:id { description: "Updated with findings..." }
  → PATCH /api/v1/tasks/:id/transition { status: "done" }
```

### 7.2 Agentbox Integration (Phase 2)

The agentbox chat handler (`services/agentbox/app/chat.py`) can be extended to:
1. Auto-create a task when a work instruction is received.
2. Update task description as work progresses.
3. Transition to `done` when responding with a completion message.

This is a follow-up enhancement, not MVP. MVP requires agents to explicitly call task endpoints.

### 7.3 SOUL.md / RULES.md Guidance

Agent persona files can include task management instructions:
```markdown
## Task Tracking
When you receive a work request:
1. Create a task: POST /api/v1/tasks with a clear title.
2. Update the task description as you make progress.
3. Transition to done when work is complete.
```

## 8. Implementation Plan

### Phase 1 — MVP

| Step | Files | Description |
|------|-------|-------------|
| 1 | `services/knowledge/app/db/migrations/009_create_agent_tasks.sql` | Create `agent_tasks` table |
| 2 | `services/knowledge/app/db/migrations/010_wire_chat_task_fk.sql` | Add FK from `chat_threads.task_id` |
| 3 | `services/knowledge/app/services/task_store.py` | CRUD + transition logic |
| 4 | `services/knowledge/app/routes/tasks.py` | Agent-facing task endpoints |
| 5 | `services/knowledge/app/routes/internal_admin_tasks.py` | Internal admin endpoints |
| 6 | `services/api/src/services/task-proxy.ts` | HTTP proxy client |
| 7 | `services/api/src/routes/tasks.ts` | User-facing task routes |
| 8 | `services/api/src/openapi/openapi.yaml` | Task schema + endpoints |
| 9 | `services/ui/src/app/tasks/page.tsx` | Server component wrapper |
| 10 | `services/ui/src/app/tasks/TaskBoardClient.tsx` | Board UI (columns, cards, filters) |
| 11 | `services/ui/src/components/nav-items.ts` | Add Tasks nav link |
| 12 | Tests | pytest (store, routes) + vitest (UI) |

**Estimated file count:** 12-15 new/modified files.

### Phase 2 — Enhancements (Future)

- Drag-and-drop reordering (`dnd-kit` library).
- Agentbox auto-task creation on work dispatch.
- Event-to-task attribution (`work_id` to `task_id` mapping).
- Task comments (reuse chat message model).
- Subtasks / checklists.
- Board swimlanes (group by agent or priority).
- Progression system: "First Task", "10 Tasks Completed" artifacts.

## 9. Migration Numbering

Current highest migration in knowledge service: `008_add_notebook_entry_type.sql`.
Next available: `009`, `010`.

## 10. OpenAPI Additions

New schemas:
- `AgentTask` — full task object
- `CreateTaskRequest` — title, description, priority, plan_id, tags
- `UpdateTaskRequest` — partial update
- `TransitionTaskRequest` — status only

New paths:
- `/tasks` — GET (list), POST (create)
- `/tasks/{id}` — GET, PUT, DELETE
- `/tasks/{id}/transition` — PATCH

## 11. Security Considerations

- Agent-facing routes use Ed25519 JWT auth. Agents can only CRUD their own tasks.
- User-facing routes use Keycloak JWT + `requireRole('user')`. Ownership scoped via `scopeToOwner`.
- Admin users see all tasks across all agents.
- No elevated scope required — tasks are informational, not capability-granting.
- Task deletion is soft (status to cancelled), not hard delete, preserving audit trail.

## 12. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents don't adopt task creation | Low adoption | Agentbox auto-creation in Phase 2; SOUL.md guidance in Phase 1 |
| Board UI complexity without DnD | Reduced UX | Click-to-transition in MVP; add DnD in Phase 2 |
| Task spam from chatty agents | Noisy board | Rate limit: max 50 active tasks per agent; prune stale tasks |
| Migration ordering conflict | Build failure | Coordinate migration numbers at implementation time |
