# Memory Model Boundaries

**Status:** Approved | **Date:** 2026-04-04 | **Linear:** AI-111

The Hill90 platform provides two knowledge systems: **AKM** (Agent Knowledge Memory) for per-agent persistent memory and the **Shared Knowledge Base** (Library) for user-curated reference material. This document defines what belongs where, how they interact, and the API surface for each.

---

## Design Principles

1. **Agents write AKM; users write Library.** There is no cross-write path.
2. **Agents read both.** An agent can recall its own AKM entries and search the Library in a single runtime session.
3. **Visibility is enforced at the data layer**, not just middleware. Every query includes a scoping WHERE clause.
4. **The two systems share infrastructure, not data.** Same database, same JWT verifier, same service token. Zero FK relationships between their tables.

---

## System Comparison

| Dimension | AKM (per-agent memory) | Library (shared knowledge) |
|-----------|----------------------|---------------------------|
| **Purpose** | Long-term agent memory — what the agent has learned, decided, and planned | User-curated reference material — external documents, web content, internal notes |
| **Data owner** | Agent (`agent_id` column) | User (`created_by` column) |
| **Who writes** | Agent (runtime, via EdDSA JWT) | User (UI/API, via Keycloak JWT) |
| **Who reads** | Agent: own entries only. User: entries for agents they own. | Agent: owner's private + all shared collections. User: own + shared collections. |
| **Content types** | Structured entries: `plan`, `decision`, `journal`, `research`, `context`, `note` | Ingested sources: `text`, `markdown`, `web_page` — chunked into ~500-token segments |
| **Retention** | Persistent until agent archives. Agent lifecycle bound. | Persistent until user deletes. Independent of agent lifecycle. |
| **Search** | FTS within one agent's entries | FTS across all visible collections, with citation provenance |
| **Visibility model** | Private per agent — no sharing | Per-collection: `private` (owner only) or `shared` (all users + their agents) |

---

## What Belongs Where

### Goes in AKM

- Agent's internal reasoning trace (plans, decisions)
- Task journals and progress notes
- Research findings the agent produced during work
- Contextual observations about the codebase or environment
- Any content the agent generates and may want to recall later

**Rule of thumb:** If the agent _produced_ it, it belongs in AKM.

### Goes in Library

- External documentation ingested from URLs
- Team-wide reference material (standards, style guides, domain glossaries)
- User-written notes or markdown meant for agents to reference
- Any content a user provides for agents to use as grounding material

**Rule of thumb:** If a _human curated_ it for agents to reference, it belongs in Library.

### Does Not Belong in Either

- Ephemeral conversation context (belongs in chat message history)
- Secrets or credentials (belongs in Vault)
- Agent configuration or identity (belongs in SOUL.md / RULES.md files)
- Structured operational data (belongs in application tables)

---

## Database Schema

Both systems live in the `hill90_akm` PostgreSQL database. They share no foreign keys.

### AKM Tables

```
knowledge_entries        — Agent-written memory entries
  id              UUID PK
  agent_id        TEXT           ← scoping key (agent slug)
  path            TEXT           ← hierarchical path (e.g., research/findings/auth)
  title           TEXT
  entry_type      ENUM(plan, decision, journal, research, context, note)
  body            TEXT
  content_hash    TEXT
  tags            TEXT[]
  status          ENUM(active, archived)
  search_vector   TSVECTOR      ← auto-maintained by trigger
  UNIQUE(agent_id, path)

knowledge_links          — Cross-reference links between entries (future)
revoked_tokens           — Blacklisted JTIs for token revocation
```

### Library Tables

```
shared_collections       — User-owned knowledge collections
  id              UUID PK
  name            VARCHAR(256)
  visibility      VARCHAR(16)   ← 'private' or 'shared'
  created_by      VARCHAR(255)  ← user sub (owner)
  UNIQUE(name, created_by)

shared_sources           — Individual sources within a collection
  id              UUID PK
  collection_id   UUID FK → shared_collections
  source_type     VARCHAR(32)   ← 'text', 'markdown', 'web_page'
  source_url      VARCHAR(2048) ← for web_page type
  raw_content     TEXT
  status          VARCHAR(16)   ← 'pending', 'active', 'error', 'archived'

shared_ingest_jobs       — Async ingestion tracking
shared_documents         — Processed documents from sources
shared_chunks            — Searchable text chunks (~500 tokens)
  search_vector   TSVECTOR      ← auto-maintained by trigger

shared_retrievals        — Audit trail for all searches
  requester_type  VARCHAR(16)   ← 'user' or 'agent'
  requester_id    VARCHAR(255)
  agent_owner     VARCHAR(255)  ← for agent requests, the owning user
  duration_ms     INTEGER
```

---

## API Surface

### Agent-Facing Endpoints (EdDSA JWT Auth)

All authenticated via Ed25519 JWT signed by the API service at agent start. JWT includes `sub` (agent_id), `owner` (creating user's sub), and `scopes`.

**AKM — `/api/v1/entries`**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/entries` | Create memory entry `{path, title, entry_type, body, tags}` |
| GET | `/api/v1/entries` | List own entries (optional `?type=` filter) |
| GET | `/api/v1/entries/{path}` | Read single entry by path |
| PUT | `/api/v1/entries/{path}` | Update entry content |
| DELETE | `/api/v1/entries/{path}` | Archive entry (soft-delete) |
| GET | `/api/v1/search?q=` | FTS across own entries |

**Scoping:** `WHERE agent_id = jwt.sub` — agent sees only its own entries.

**Library — `/api/v1/shared`**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/shared/search?q=` | FTS across visible collections, returns ranked chunks with citations |
| GET | `/api/v1/shared/collections` | List visible collection metadata |

**Scoping:** `WHERE (created_by = jwt.owner OR visibility = 'shared') AND status = 'active'`

### User-Facing Endpoints (Keycloak RS256 JWT Auth)

**AKM — `/knowledge/*`** (read-only for users)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/knowledge/agents` | List agents with entry counts |
| GET | `/knowledge/entries?agent_id=` | List entries for an agent |
| GET | `/knowledge/entries/:agentId/:path` | Read single entry |
| GET | `/knowledge/search?q=` | FTS across owned agents' entries |

**Scoping:** Admin sees all. Users see only agents they created.

**Library — `/shared-knowledge/*`** (full CRUD for users)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/shared-knowledge/collections` | List own + shared collections |
| POST | `/shared-knowledge/collections` | Create collection `{name, description, visibility}` |
| PUT | `/shared-knowledge/collections/:id` | Update (owner only) |
| DELETE | `/shared-knowledge/collections/:id` | Delete (owner only) |
| GET | `/shared-knowledge/sources?collection_id=` | List sources in collection |
| POST | `/shared-knowledge/sources` | Create source (triggers async ingest) |
| DELETE | `/shared-knowledge/sources/:id` | Delete source (owner only) |
| GET | `/shared-knowledge/search?q=` | Search across visible collections |
| GET | `/shared-knowledge/stats` | Aggregate quality metrics |

### Internal Proxy Endpoints (Service Token Auth)

The API service proxies to the knowledge service using `AKM_INTERNAL_SERVICE_TOKEN` (timing-safe Bearer comparison).

| Proxy | Internal Path | Purpose |
|-------|--------------|---------|
| AKM | `/internal/admin/agents`, `/entries`, `/search` | User-facing AKM reads |
| Library | `/internal/admin/shared/collections`, `/sources`, `/search`, `/stats` | User-facing Library CRUD |

---

## Interaction Model

### How an Agent Uses Both Systems

During a work session, an agent can:

1. **Recall prior work** — `GET /api/v1/entries` or `/api/v1/search?q=` from AKM
2. **Reference shared material** — `GET /api/v1/shared/search?q=` from Library
3. **Record new learning** — `POST /api/v1/entries` to AKM

The agent never writes to Library. The agent never reads another agent's AKM entries.

```
                    ┌─────────────┐
                    │   Agent     │
                    │  (runtime)  │
                    └──────┬──────┘
                           │ EdDSA JWT
                   ┌───────┴───────┐
                   │               │
              read/write        read only
                   │               │
            ┌──────▼──────┐ ┌──────▼──────┐
            │     AKM     │ │   Library   │
            │ (per-agent) │ │  (shared)   │
            └─────────────┘ └─────────────┘
                   │               │
                   └───────┬───────┘
                           │
                    ┌──────▼──────┐
                    │  hill90_akm │
                    │  (Postgres) │
                    └─────────────┘
```

### How a User Uses Both Systems

A user manages both through the UI:

1. **View agent memory** — Browse an agent's AKM entries in the harness UI
2. **Curate Library** — Create collections, add sources, search for content
3. **Monitor quality** — View search stats and zero-result rates

The user never writes to AKM directly. Agent memory is agent-authored.

```
                    ┌─────────────┐
                    │    User     │
                    │    (UI)     │
                    └──────┬──────┘
                           │ Keycloak JWT
                   ┌───────┴───────┐
                   │               │
               read only       full CRUD
                   │               │
            ┌──────▼──────┐ ┌──────▼──────┐
            │     AKM     │ │   Library   │
            │ (per-agent) │ │  (shared)   │
            └─────────────┘ └─────────────┘
```

---

## Access Control Matrix

| Principal | AKM Read | AKM Write | Library Read | Library Write |
|-----------|----------|-----------|--------------|---------------|
| Agent (own) | Own entries | Own entries | Owner's private + all shared | Never |
| Agent (other) | Never | Never | Never | Never |
| User (owner) | Owned agents | Never | Own + shared | Own collections |
| User (other) | Never | Never | Shared only | Never |
| Admin | All agents | Never | All collections | All collections |
| Service token | All (proxy) | Never | All (proxy) | All (proxy) |

---

## Search Behavior

### AKM Search

- **Scope:** Single agent's entries (scoped by `agent_id`)
- **Method:** PostgreSQL FTS via `websearch_to_tsquery('english', q)`
- **Ranking:** `ts_rank(search_vector, query)` descending
- **Returns:** `{query, results: [{id, path, title, entry_type, body_snippet, score}], count}`
- **No audit trail** — agent searching its own memory is private

### Library Search

- **Scope:** Owner's private collections + all shared collections
- **Method:** PostgreSQL FTS via `websearch_to_tsquery('english', q)` on `shared_chunks.search_vector`
- **Ranking:** `ts_rank` with title weight (A) + content weight (B)
- **Returns:** Ranked chunks with citation chain: `chunk → document → source → collection`
- **Audit trail:** Every search recorded in `shared_retrievals` (requester type/id, result count, duration)
- **Privacy:** Stats endpoint exposes aggregates only — no raw queries or requester IDs

### Cross-System Search

There is no single endpoint that searches both AKM and Library simultaneously. An agent that needs to check both issues two separate requests. This is by design: the scoping models are fundamentally different (agent-scoped vs. owner-scoped), and merging results would conflate provenance.

A future orchestration layer could issue both searches and merge results, but that belongs in the agent's runtime logic (agentbox), not in the knowledge service.

---

## Ingestion Pipeline (Library Only)

AKM entries are written directly by agents — no ingestion pipeline needed.

Library sources go through an async ingest pipeline:

```
User creates source (POST /shared-knowledge/sources)
    │
    ├─ text/markdown: Store raw_content directly
    │   └─ Chunk into ~500-token segments with ~50-token overlap
    │
    └─ web_page: Fetch URL with SSRF protection
        ├─ DNS pre-check (blocks loopback, RFC1918, link-local, Tailscale/CGNAT)
        ├─ Manual redirect following (max 3 hops, re-validation per hop)
        ├─ Streaming body with 2MB size limit
        ├─ HTML extraction via trafilatura
        └─ Chunk extracted text
    │
    ├─ INSERT shared_documents (one per source)
    ├─ INSERT shared_chunks (N per document)
    ├─ UPDATE shared_sources SET status='active'
    └─ UPDATE shared_ingest_jobs SET status='completed', chunk_count=N
```

---

## Lifecycle & Cleanup

### AKM Entry Lifecycle

```
Agent creates entry (status='active')
    → Agent updates entry (body changes, content_hash updates)
    → Agent archives entry (status='archived', soft-delete)
    → Entry retained in DB (queryable by user, filtered from agent searches)
```

When an agent is deleted, its AKM entries remain in the database (orphaned but queryable by admin). A future cleanup job could prune entries for deleted agents.

### Library Source Lifecycle

```
User creates source (status='pending')
    → Ingest job runs (status='running')
    → Success: status='active', chunks created
    → Failure: status='error', error_message set
    → User deletes: cascading delete of documents/chunks
```

Collection deletion cascades to sources, documents, chunks. Retrieval audit records are retained (they reference chunk IDs but don't depend on chunks existing).

---

## Future Considerations

### Semantic Search (Deferred)

Both systems use PostgreSQL FTS today. A future upgrade to pgvector/embeddings would:
- Add `embedding` column to `knowledge_entries` and `shared_chunks`
- Enable cosine similarity search alongside FTS
- Require embedding generation at write time (AKM) and ingest time (Library)
- Gated on evidence that FTS recall is insufficient (per `.claude/plans/dazzling-wondering-mitten.md`)

### Agent-to-Library Write Path (Not Planned)

Agents do not write to Library. If needed in the future, this would require:
- A new entry type or collection type distinguishing agent-contributed from user-curated
- Review/approval workflow (user approves before content becomes visible)
- Separate audit trail for agent-contributed content

This is explicitly out of scope. Agents write to AKM; users curate Library.

### Cross-Agent AKM Access (Not Planned)

Agents cannot read other agents' AKM entries. If multi-agent knowledge sharing is needed, the Library is the correct mechanism: a user extracts relevant knowledge from one agent's AKM and curates it into a shared collection.

---

## References

- Agent Identity Model: `docs/architecture/agent-identity-model.md`
- Agent Harness Architecture: `docs/architecture/agent-harness.md`
- AKM migration: `services/knowledge/app/db/migrations/001_create_knowledge_entries.sql`
- Library migration: `services/knowledge/app/db/migrations/006_create_shared_knowledge.sql`
- Quality stats migration: `services/knowledge/app/db/migrations/007_add_retrieval_duration.sql`
- Shared KB Phase 3 plan (deferred): `.claude/plans/dazzling-wondering-mitten.md`
