# Agent Progression System — Unified Design Spec

**Linear:** AI-124, AI-125, AI-126, AI-127, AI-128 | **Date:** 2026-04-04 | **Status:** Spec complete | **Priority:** Low

## Executive Summary

A character-style progression system for agents that surfaces what they've done, learned, and achieved — without altering the permission model. Progression is **discovery-oriented and informational**, not capability-gating. Skills remain admin-assigned; the progression layer adds identity, visibility, and personality.

### Hard Constraints (Non-Negotiable)

1. **No automatic skill unlocks.** Progression never grants new scopes, tools, or permissions.
2. **No RBAC/scope bypass.** The skill assignment + elevated scope governance model is unchanged.
3. **No runtime permission changes.** An agent's runtime capabilities are determined solely by its assigned skills, model policy, and container profile — not by progression state.
4. **Presentation-only.** Progression data enriches the UI. It does not appear in agent config, work dispatch, or policy enforcement.

---

## System Overview

```
┌─────────────────────────────────────────────────┐
│                Agent Profile Card                │
│  ┌────────┐  Name: ResearchBot                  │
│  │ Avatar │  Status: Running · 47d uptime       │
│  │  (img) │  Profile: Standard                   │
│  └────────┘  Skills: Developer · Host·Docker     │
│                                                  │
│  ┌─ Stats ──────────────────────────────────┐   │
│  │ Inference: 12,847 │ Knowledge: 342 entries│   │
│  │ Tasks: 89 complete │ Uptime: 47d 3h       │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌─ Artifacts ──────────────────────────────┐   │
│  │ 🏗 First Plan    📚 Library Contributor    │   │
│  │ 🔬 Deep Research  💬 Chat Veteran          │   │
│  │ 🛡 Elevated Ops  ⚡ 10K Inferences        │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌─ Knowledge Domains ──────────────────────┐   │
│  │ typescript ████████░░  infrastructure ███░░│   │
│  │ python ██████░░░░  security ██░░░░░░░░    │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## 1. Avatar System (AI-124, AI-126)

### Concept

Each agent has an optional avatar image. Avatars are cosmetic — they appear on agent cards, chat messages, and the profile page.

### Design

| Property | Spec |
|----------|------|
| Storage | `agents.avatar_url` column (VARCHAR, nullable). URL to image. |
| Upload | Admin uploads via agent edit form → stored in MinIO bucket `agent-avatars` |
| Fallback | No avatar → colored circle with first letter of agent name (existing pattern) |
| Formats | PNG, JPG, WebP. Max 512KB. Resized server-side to 128x128. |
| Display | Agent list cards, agent detail header, chat message bubbles (replacing Bot icon) |

### UI: Avatar Picker

In the agent edit form, an avatar section:
- Current avatar preview (128x128 circle)
- "Upload" button → file picker (image types only)
- "Remove" button → clears avatar, reverts to letter fallback
- Preview updates immediately (client-side before upload)

---

## 2. Stats Summary (AI-124, AI-126)

### Concept

Aggregate counters derived from existing data sources. No new data collection — stats are computed from `model_usage`, `knowledge_entries`, `chat_messages`, and container lifecycle events.

### Stat Definitions

| Stat | Source | Computation |
|------|--------|-------------|
| **Total Inferences** | `model_usage` table | `COUNT(*) WHERE agent_id = $1` |
| **Total Tokens** | `model_usage` table | `SUM(input_tokens + output_tokens) WHERE agent_id = $1` |
| **Estimated Cost** | `model_usage` table | `SUM(cost_usd) WHERE agent_id = $1` |
| **Knowledge Entries** | `knowledge_entries` table (AKM) | Count via `/internal/admin/agents` (already returns counts) |
| **Chat Messages** | `chat_messages` table | `COUNT(*) WHERE author_id = $1 AND author_type = 'agent'` |
| **Tasks Completed** | `chat_messages` with `status = 'complete'` | `COUNT(*) WHERE author_id = $1 AND status = 'complete'` |
| **Total Uptime** | Agent start/stop lifecycle | `SUM(stop_time - start_time)` across all sessions. Requires new `agent_sessions` tracking (see schema below). |
| **First Started** | `agents.created_at` | Existing column |
| **Skills Assigned** | `agent_skills` join | Count of current skills |
| **Library Contributions** | `shared_sources` table | `COUNT(*) WHERE created_by = $agent_owner` (approximation via owner) |

### UI: Stats Panel

A compact grid on the agent detail page (Overview tab), below the current agent info section:

```
┌─────────────────┬─────────────────┬─────────────────┐
│  12,847          │  2.1M           │  $14.23          │
│  Inferences     │  Tokens         │  Est. Cost       │
├─────────────────┼─────────────────┼─────────────────┤
│  342             │  89             │  47d 3h          │
│  Knowledge      │  Messages       │  Total Uptime    │
└─────────────────┴─────────────────┴─────────────────┘
```

Stats are read-only. No editing. Computed on page load via a single aggregate API call.

---

## 3. Progression Signals (AI-125)

### Concept

Observable events in an agent's lifetime that indicate meaningful activity. Signals are the raw inputs; artifacts (section 4) are the user-visible outputs.

### Signal Catalog

| Signal ID | Event | Source | Threshold |
|-----------|-------|--------|-----------|
| `first_inference` | First successful model inference | `model_usage` | 1 row |
| `inference_1k` | 1,000 inferences | `model_usage` | COUNT ≥ 1000 |
| `inference_10k` | 10,000 inferences | `model_usage` | COUNT ≥ 10000 |
| `first_knowledge` | First knowledge entry created | AKM entries | 1 entry |
| `knowledge_100` | 100 knowledge entries | AKM entries | COUNT ≥ 100 |
| `first_plan` | First `plan` type entry | AKM entries | 1 plan entry |
| `first_decision` | First `decision` type entry | AKM entries | 1 decision entry |
| `first_research` | First `research` type entry | AKM entries | 1 research entry |
| `first_chat` | First chat message sent | `chat_messages` | 1 message |
| `chat_100` | 100 chat messages | `chat_messages` | COUNT ≥ 100 |
| `first_library` | First shared knowledge contribution | `shared_sources` | 1 source |
| `elevated_assigned` | Elevated scope skill assigned | `agent_skills` + `skills.scope` | Any host_docker/vps_system |
| `multi_model` | Agent uses 2+ different models | `model_usage` DISTINCT model | ≥ 2 |
| `uptime_7d` | 7 days cumulative uptime | Session tracking | ≥ 7d |
| `uptime_30d` | 30 days cumulative uptime | Session tracking | ≥ 30d |

### Anti-Noise Rules

- **No self-referential signals.** "Agent started" is not a progression event — it's operational.
- **No count-only signals below meaningful thresholds.** The first inference matters; the 5th doesn't until 1,000.
- **No negative signals.** Errors, failures, and revocations are operational concerns, not progression.
- **Idempotent evaluation.** Recalculating signals from scratch produces the same result. No ephemeral state.

---

## 4. Artifacts (AI-125, AI-127)

### Concept

Artifacts are the user-visible achievements derived from progression signals. They appear as badges on the agent profile card and in a shelf/timeline view.

### Artifact Catalog

| Artifact | Signal(s) | Icon | Description |
|----------|-----------|------|-------------|
| **First Light** | `first_inference` | ⚡ | Completed first model inference |
| **Thousand Calls** | `inference_1k` | 🔥 | 1,000 inferences completed |
| **Ten Thousand** | `inference_10k` | 💫 | 10,000 inferences completed |
| **First Plan** | `first_plan` | 🏗 | Created first plan document |
| **Decision Maker** | `first_decision` | ⚖️ | Recorded first architecture decision |
| **Deep Research** | `first_research` | 🔬 | Conducted first research investigation |
| **Memory Keeper** | `knowledge_100` | 🧠 | Accumulated 100 knowledge entries |
| **Chat Veteran** | `chat_100` | 💬 | Sent 100 chat messages |
| **Library Contributor** | `first_library` | 📚 | Contributed to the shared library |
| **Elevated Ops** | `elevated_assigned` | 🛡 | Assigned elevated-scope skill (host_docker or vps_system) |
| **Polyglot** | `multi_model` | 🌐 | Used 2+ different models |
| **Week Runner** | `uptime_7d` | ⏱ | 7 days cumulative uptime |
| **Month Runner** | `uptime_30d` | 🏃 | 30 days cumulative uptime |

### Artifact Properties

```typescript
interface Artifact {
  id: string           // e.g., "first_light"
  name: string         // "First Light"
  description: string  // "Completed first model inference"
  icon: string         // emoji
  signal_id: string    // FK to signal that triggers this artifact
  earned_at: string    // ISO timestamp when signal threshold was first met
  evidence_url?: string // optional link to the source event (e.g., usage page filtered to agent)
}
```

### Discovery vs Grant

Artifacts are **discovered, not granted.** The system evaluates signals from existing data on demand (when the profile page loads or a background job runs). There's no "grant artifact" API — artifacts exist if and only if their signal threshold is met.

This means artifacts can be computed retroactively for existing agents without data migration.

---

## 5. Knowledge Domain Profile (AI-128)

### Concept

A visual summary of what knowledge domains an agent has accumulated, derived from knowledge entry analysis.

### Domain Derivation

Domains are extracted from knowledge entry metadata:
- **Tags** on knowledge entries (`knowledge_entries.tags` array)
- **Path prefixes** (e.g., entries under `research/typescript/` → `typescript` domain)
- **Entry type distribution** (e.g., heavy `plan` entries → "planning" domain)

### Domain Display

Horizontal bar chart on the agent profile, showing top 5 domains by entry count:

```
typescript    ████████░░  (42 entries)
python        ██████░░░░  (28 entries)
infrastructure ███░░░░░░  (15 entries)
security      ██░░░░░░░░  (9 entries)
deployment    █░░░░░░░░░  (5 entries)
```

### Provenance Links

Each domain is clickable → navigates to Knowledge page filtered to that agent + domain tag, showing the actual entries that contributed to the domain score.

---

## 6. UI: Customize Agent Page (AI-126)

### Page Location

New tab on agent detail page: **Profile** (added between Overview and Configuration tabs).

### Layout

Three sections, vertically stacked:

**Section 1: Identity**
- Avatar (128x128, editable via picker)
- Agent name + slug (read-only)
- Container profile badge
- Status + uptime
- "Edit Avatar" button (admin only)

**Section 2: Stats + Artifacts**
- Stats grid (6 counters, 2 rows × 3 columns)
- Artifact shelf: grid of earned artifact badges
- Unearned artifacts shown as muted/locked (ghost state with `?` icon)
- Hover on artifact → tooltip with name + description + earned date

**Section 3: Knowledge Domains**
- Domain bar chart (top 5)
- "View All" link → Knowledge page for this agent

### Empty States

- **No stats yet:** "Start the agent to begin tracking progression."
- **No artifacts:** "No artifacts discovered yet. Artifacts are earned through agent activity."
- **No knowledge:** "No knowledge entries. Assign a knowledge skill to start learning."

---

## 7. Schema Additions

### `agents` table (existing)

```sql
ALTER TABLE agents ADD COLUMN avatar_url VARCHAR(512) DEFAULT NULL;
```

### `agent_sessions` table (new — for uptime tracking)

```sql
CREATE TABLE agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id);
```

Populated by agent start/stop lifecycle in `agents.ts`. Start creates a row; stop sets `stopped_at`.

### No artifacts table

Artifacts are computed on-demand from existing data. No persistence needed. This avoids sync drift between artifacts and their source signals.

---

## 8. API Additions

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/agents/:id/stats` | Aggregate stats (inference count, tokens, cost, knowledge, chat, uptime) |
| `GET` | `/agents/:id/artifacts` | Computed artifact list (earned + unearned) |
| `GET` | `/agents/:id/domains` | Knowledge domain breakdown (top N) |
| `PUT` | `/agents/:id/avatar` | Upload avatar image (admin only, multipart) |
| `DELETE` | `/agents/:id/avatar` | Remove avatar |

Stats and artifacts are computed per-request (no caching initially). If performance becomes an issue, add a materialized view or periodic background computation.

---

## 9. Implementation Phasing

| Phase | Scope | Effort | Depends On |
|-------|-------|--------|------------|
| **P1: Stats** | Stats API + stats panel on agent detail | 2-3 days | Nothing |
| **P2: Avatar** | Avatar upload, storage, display across UI | 2-3 days | MinIO bucket setup |
| **P3: Artifacts** | Signal evaluation, artifact computation, badge shelf | 3-4 days | P1 (stats provide signal data) |
| **P4: Domains** | Knowledge domain extraction, bar chart | 2-3 days | Nothing (reads AKM data) |
| **P5: Profile Tab** | Unified profile tab combining P1-P4 | 1-2 days | P1-P4 |
| **Total** | | **10-15 days** | |

**Recommendation:** Start with P1 (stats) — it provides immediate value and validates the data pipeline. P2 (avatar) is independent and can run in parallel.

---

## 10. What This Design Does NOT Cover

- **Leaderboards or agent comparison.** Progression is per-agent, not competitive.
- **XP points or levels.** Avoided intentionally — artifacts are binary (earned/not earned), not cumulative scores that invite gaming.
- **Skill unlock triggers.** Explicitly prohibited by hard constraint #1.
- **Progression notifications/alerts.** Artifacts are discovered on profile view, not pushed.
- **Custom artifact creation.** Artifact catalog is code-defined. Users cannot create custom artifacts.
- **Agent-to-agent artifact sharing.** Each agent's progression is independent.

---

## See Also

- [Agent Harness Architecture](./agent-harness.md) — Runtime contract, lifecycle, container profiles
- [Agent Identity Model](./agent-identity-model.md) — Principal types, ownership, JWT claims
