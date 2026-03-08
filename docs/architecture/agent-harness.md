# Agent Harness Architecture

The agent harness is the subsystem that creates, configures, runs, and manages AI agents on the Hill90 platform. It comprises four cooperating services: the **API control plane**, the **agentbox runtime**, the **model-router** (AI service), and the **Agent Knowledge Manager** (AKM).

## System Overview

```
User (UI / API client)
  │
  ▼
API Service (Express, api.hill90.com)
  │  CRUD, lifecycle, token signing, config generation
  │
  ├──────────────────────────┬──────────────────────────┐
  │                          │                          │
  ▼                          ▼                          ▼
Agentbox Container       AI Service (FastAPI)      Knowledge Service (FastAPI)
(Runtime, port 8054)     (port 8000, internal)     (port 8002, internal)
  │  shell, filesystem,    │  policy-gated LLM       │  entries, search,
  │  runtime (/work)       │  inference, BYOK        │  journal, context
  │                        │                          │
  │                        ▼                          ▼
  │                     LiteLLM (:4000)           PostgreSQL (hill90_akm)
  │                        │
  │                        ▼
  │                     Provider APIs
  │                     (OpenAI, Anthropic, ...)
  │
  ▼
PostgreSQL (hill90)
```

**Network topology**: Three Docker networks isolate traffic.

- **`hill90_edge`** — Public-facing. Traefik routes external requests to API, UI, Keycloak, and the MCP gateway path on `ai.hill90.com/mcp`.
- **`hill90_internal`** — Service mesh. API, AI, Knowledge, Keycloak, PostgreSQL, and LiteLLM communicate here. Not publicly routed.
- **`hill90_agent_internal`** — Agent isolation. Agentbox containers reach the AI service and Knowledge service but cannot access the edge network or public internet.

The AI service and Knowledge service both set `traefik.enable=false` — they are internal-only. The `ai.hill90.com` hostname exists for TLS/DNS but only the MCP gateway (`/mcp` path prefix) is publicly routed through it.

**Data flow**: Agent create → config write → start (JWT injection) → runtime (inference + knowledge) → stop (token revocation).

---

## Agentbox Runtime

Agentbox is a sandboxed runtime container for AI agents. It uses plain Starlette/uvicorn as its HTTP layer. The runtime contract below defines what the container provides.

### Container Image

- **Base**: `python:3.12-slim` with `bash`, `git`, `curl`, `wget`, `jq`, `rsync`, `vim`, `make`
- **User**: `agentuser` (UID 1000) — non-root
- **Port**: 8054 (streamable HTTP)
- **Health check**: `curl -sf http://localhost:8054/health` (30s interval, 10s timeout, 3 retries)

### Tool Functions

Shell and filesystem logic lives in `app/shell.py` and `app/filesystem.py` as plain Python modules. These are policy-gated functions callable by any future work dispatcher — no MCP protocol involvement.

| Function | Module | Policy-gated |
|----------|--------|-------------|
| `execute_command` | `app.shell` | Yes (CommandPolicy) |
| `check_command` | `app.shell` | Yes (CommandPolicy) |
| `read_file` | `app.filesystem` | Yes (PathPolicy) |
| `write_file` | `app.filesystem` | Yes (PathPolicy) |
| `list_directory` | `app.filesystem` | Yes (PathPolicy) |

### Runtime Endpoints

Plain Starlette HTTP routes served by uvicorn on port 8054.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Docker healthcheck liveness probe |
| POST | `/work` | Bearer `WORK_TOKEN` | Workload receiver (Phase 2 stub — accepts, emits events, returns ack; no execution) |

**`POST /work` contract**:

```
Request:  { "type": str, "payload": dict, "correlation_id": str | null }
Success:  200 { "accepted": true, "work_id": "<uuid>", "type": "<echoed>" }
Invalid:  400 { "error": "validation_error", "detail": "<message>" }
Unauth:   401 { "error": "unauthorized" }
```

**`WORK_TOKEN` auth model**: The API service generates a `crypto.randomUUID()` at container start and injects it as the `WORK_TOKEN` env var. The token is ephemeral — it exists only in API process memory (briefly) and the container environment. It is not stored in the database or any API response. No external service can look up the token in Phase 2 — this is intentional; a caller arrives in Phase 3+.

### Policy Enforcement

**Shell policy** (`CommandPolicy`):
- Binary allowlist (optional) — if provided, command binary must resolve to an allowed path via `shutil.which`
- Denied pattern regex list — applied to raw command string before execution (e.g., `rm\s+-rf\s+/`, fork bomb patterns)
- Execution via `subprocess.run(shell=False)` with explicit argv — no shell injection
- Stripped environment: only `PATH`, `HOME`, `LANG`, `TERM` — no inherited secrets
- Timeout clamped to configurable `max_timeout` (default 300s)
- Output truncation: stdout 100KB, stderr 10KB

**Filesystem policy** (`PathPolicy`):
- Symlink resolution via `os.path.realpath()` before checking — blocks symlink traversal
- Allowed paths allowlist (default: `/workspace`)
- Denied paths denylist (default: `/etc/shadow`, `/etc/passwd`, `/root`)
- Read-only mode option blocks all write operations

### Configuration Files

The API service writes three files to `/etc/agentbox/` (read-only mount) before starting a container:

- **`agent.yml`** — YAML config defining tools, resource limits, and state paths
- **`SOUL.md`** — Agent identity/persona document (loaded by `AgentRuntime` at startup)
- **`RULES.md`** — Operating rules and constraints (loaded by `AgentRuntime` at startup)

**`agent.yml` structure**:

```yaml
version: 1
id: my-agent                    # slug: lowercase alphanumeric + hyphens, 1-63 chars
name: "My Agent"
description: "Purpose of the agent"
soul_path: SOUL.md              # relative to config directory
rules_path: RULES.md
tools:
  shell:
    enabled: true
    allowed_binaries: [/usr/bin/git, /usr/bin/curl, /bin/bash]
    denied_patterns: ["rm\\s+-rf\\s+/"]
    max_timeout: 300
  filesystem:
    enabled: true
    read_only: false
    allowed_paths: [/workspace, /tmp]
    denied_paths: [/etc/shadow, /etc/passwd, /root]
  health:
    enabled: true               # deprecated — kept for YAML compatibility, no effect
# NOTE: tools.shell.enabled, tools.filesystem.enabled, and tools.health.enabled
# are parsed for YAML compatibility but no longer drive tool registration.
# Shell and filesystem functions are available as direct Python imports.
resources:
  cpus: "1.0"
  mem_limit: "1g"
  pids_limit: 200
state:
  workspace: /workspace
  logs: /var/log/agentbox
  data: /data
```

### Container Resources

Docker enforces resource limits from agent configuration:

- **CPU**: `NanoCPUs = cpus * 1e9`
- **Memory**: parsed from suffix (e.g., `1g` → bytes)
- **PIDs**: max process count (default 200)
- **Volumes**: three named volumes per agent — `agentbox-{agent_id}-workspace`, `agentbox-{agent_id}-logs`, `agentbox-{agent_id}-data`
- **Network**: `hill90_agent_internal` only

### Runtime Events

Agentbox emits structured JSONL events for every tool invocation, providing operators with real-time visibility into agent behavior without exposing raw command output or file contents.

**Event file**: `/var/log/agentbox/events.jsonl` (inside the agent container, on the `agentbox-{agent_id}-logs` volume)

**Event schema**:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique event identifier |
| `timestamp` | string (ISO 8601) | Event time in UTC |
| `type` | string | Event type (see table below) |
| `tool` | string | Tool category: `shell`, `filesystem`, `runtime` |
| `input_summary` | string | What was requested (truncated to 200 chars) |
| `output_summary` | string or null | Structured metadata about the result — never raw content |
| `duration_ms` | integer or null | Execution time in milliseconds |
| `success` | boolean or null | Whether the operation succeeded |
| `metadata` | object or null | Optional additional key-value data |

**Event types and output policy**:

| Event Type | Tool | `input_summary` | `output_summary` | What is NOT persisted |
|---|---|---|---|---|
| `command_start` | shell | Command string (≤200 chars) | `null` | N/A |
| `command_complete` | shell | Command string (≤200 chars) | `"exit {code}, {N} bytes stdout"` | stdout/stderr content |
| `file_read` | filesystem | File path | `"{N} bytes"` | File contents |
| `file_write` | filesystem | File path | `"{N} bytes written"` | File contents |
| `directory_list` | filesystem | Directory path | `"{N} entries"` | Directory listing |
| `work_received` | runtime | `"type={type} correlation_id={id}"` | `null` | N/A |
| `work_completed` | runtime | `"type={type} correlation_id={id}"` | `"work_id={id} (stub)"` | Work payload |
| `work_failed` | runtime | `"type={type} correlation_id={id}"` | Error detail | Work payload |

**Redaction policy**: No raw stdout, stderr, or file contents are persisted in any event. The `output_summary` field contains only structured metadata (exit codes, byte counts, percentages). Shell command strings in `input_summary` may contain inline secrets — this is comparable to shell history behavior and is an accepted V1 limitation.

**Access**: `GET /agents/{id}/events` with `requireRole('user')` and owner scoping (same pattern as `GET /agents/{id}`). Supports SSE streaming (`?follow=true`) or one-shot JSON array. Returns 409 for stopped agents — events are readable only while the container exists.

**V1 limitations**:
- Events are not persisted to a database — they exist only in the container's log volume
- After container removal (agent stop), the events endpoint returns 409; volume data persists but has no read path
- No file rotation or size limits — agents are expected to be short-lived
- No command string secret redaction in `input_summary`

### Runtime Contract

The runtime contract defines what the container provides to **any** process running inside it, independent of MCP.

**Identity:**
- Agent config: `/etc/agentbox/agent.yml` (read-only mount)
- Agent personality: `/etc/agentbox/SOUL.md` (read-only mount)
- Agent rules: `/etc/agentbox/RULES.md` (read-only mount)

**Persistent storage:**
- Workspace: `/workspace` (Docker volume, survives restart)
- Data: `/data` (Docker volume, survives restart)
- Logs: `/var/log/agentbox` (Docker volume, survives restart)

**Environment variables:**
- `AGENT_ID` — unique agent identifier
- `AGENT_CONFIG` — path to agent.yml (`/etc/agentbox/agent.yml`)
- `AKM_TOKEN`, `AKM_SERVICE_URL` — Knowledge service credentials (if configured)
- `MODEL_ROUTER_TOKEN`, `MODEL_ROUTER_URL` — AI service credentials (if configured)
- `WORK_TOKEN` — Bearer token for `POST /work` endpoint (ephemeral, generated at container start)

**Network:**
- `hill90_agent_internal` — reaches AI service (:8000) and Knowledge service (:8002)
- No public internet access
- No access to edge network or other internal services

**Available CLIs:**
- `bash`, `git`, `curl`, `wget`, `jq`, `openssh-client`, `rsync`, `vim`, `make`, `python3`

**Event emission:**
- Any process can append JSONL to `/var/log/agentbox/events.jsonl`
- Schema: `{id, timestamp, type, tool, input_summary, output_summary, duration_ms, success, metadata}`
- The `EventEmitter` class (`app/events.py`) provides thread-safe append; direct file write also works

**Health:**
- HTTP GET on port 8054 returns `{"status": "healthy", "agent": "<id>"}`
- Docker healthcheck polls this endpoint

### Migration Status

The agentbox completed a three-phase migration from MCP-first to runtime-first architecture:

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Extract tool logic to `app/`, thin MCP wrappers in `tools/`, document runtime contract | **Complete** |
| **Phase 2** | `POST /work` endpoint, remove identity + health MCP tools, runtime events | **Complete** |
| **Phase 3** | Remove MCP transport, replace with plain Starlette/uvicorn | **Complete** |

**Current state (post-Phase 3):** Shell and filesystem business logic lives in `app/shell.py` and `app/filesystem.py` as plain Python modules. The `tools/` directory has been deleted — no MCP wrappers remain. The server uses Starlette routes + uvicorn with no MCP dependency. The `tools:` section in `agent.yml` is parsed for YAML compatibility but no longer drives tool registration. The `POST /work` endpoint provides the runtime workload contract (stub — no execution). `AgentRuntime` (`app/runtime.py`) loads identity files and handles work requests with bearer auth and structured events.

---

## Agent Lifecycle

The API service manages agents through a database-backed lifecycle with Docker container orchestration.

### Database

**Table**: `agents` (API service PostgreSQL, database `hill90`)

Key columns: `id` (UUID PK), `agent_id` (VARCHAR unique slug), `name`, `description`, `status` (stopped/running/error), `container_id`, `created_by` (Keycloak sub), `tools_config` (JSONB), `soul_md`, `rules_md`, `cpus`, `mem_limit`, `pids_limit`, `model_policy_id` (FK), `akm_jti`, `akm_exp`, `model_router_jti`, `model_router_exp`, `error_message`, `created_at`, `updated_at`.

### CRUD Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/agents` | user | Create agent with config |
| GET | `/agents` | user | List agents (scoped to owner; admin sees all) |
| GET | `/agents/{id}` | user | Get agent detail (ownership-scoped) |
| PUT | `/agents/{id}` | user | Update config (blocked while running) |
| DELETE | `/agents/{id}` | admin | Stop if running, optionally purge volumes, delete |

### Lifecycle Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/agents/{id}/start` | admin | Write config, inject tokens, create container |
| POST | `/agents/{id}/stop` | admin | Revoke tokens, stop container |
| GET | `/agents/{id}/status` | user | Live container inspection + DB state |
| GET | `/agents/{id}/events` | user | Structured event stream (SSE or JSON) |
| GET | `/agents/{id}/logs` | admin | Tail raw container logs (SSE or text) |

### Start Flow

1. **Write config files** — `writeAgentFiles()` creates `{AGENTBOX_CONFIG_HOST_PATH}/{agent_id}/` with `agent.yml`, `SOUL.md`, `RULES.md`
2. **Generate AKM token** — Ed25519 JWT (1h expiry) with claims `{sub: agent_id, iss, aud, exp, iat, jti, scopes}`. Stores JTI and expiry in DB.
3. **Generate model-router token** — Ed25519 JWT (1h expiry) with claims `{sub: agent_id, iss, aud, exp, iat, jti}`. Stores JTI and expiry in DB.
4. **Create container** — Docker container `agentbox-{agent_id}` with:
   - Read-only config mount at `/etc/agentbox`
   - Named volumes for workspace, logs, data
   - Resource limits from agent config
   - Network `hill90_agent_internal`
   - Labels: `managed-by=hill90-api`, `traefik.enable=false`
   - Environment: `AGENT_ID`, `AGENT_CONFIG`, `AKM_TOKEN`, `AKM_SERVICE_URL`, `AKM_REFRESH_SECRET`, `MODEL_ROUTER_TOKEN`, `MODEL_ROUTER_URL`, `WORK_TOKEN`
5. **Update DB** — status=running, container_id set

### Stop Flow

1. **Revoke AKM token** — POST to `{AKM_SERVICE_URL}/internal/revoke` with `{jti, agent_id, expires_at}` using internal service token. Non-fatal on error.
2. **Revoke model-router token** — POST to `{MODEL_ROUTER_URL}/internal/revoke` with same shape. Non-fatal on error.
3. **Stop container** — Validates `managed-by=hill90-api` label before removal.
4. **Clear DB** — status=stopped, container_id=NULL, JTI/exp columns cleared.

### Delete Flow

1. Stop running container (if status=running)
2. Optionally purge volumes (`?purge=true`)
3. Remove config files from host
4. Delete database record

---

## Model-Router (AI Service)

The AI service is an internal-only FastAPI application that provides policy-gated LLM inference to agent containers. It authenticates agents via Ed25519 JWTs, enforces model access policies, and proxies requests through LiteLLM to provider APIs.

### Endpoints

**Agent-facing** (Ed25519 JWT auth):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat inference (streaming SSE or JSON) |
| POST | `/v1/embeddings` | Text embeddings |
| GET | `/v1/models` | List allowed models for authenticated agent |
| POST | `/v1/delegate` | Create child delegation token with narrowed model set |
| GET | `/v1/delegations` | List active delegations for authenticated agent |
| POST | `/v1/delegations/{id}/revoke` | Revoke a specific delegation |

**Internal** (service token auth):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/revoke` | Revoke an agent JWT (called by API on agent stop) |
| POST | `/internal/delegation-token` | Sign a child delegation JWT (called by AI service itself via API) |

**Health**:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |

### Policy Enforcement Pipeline

For every inference request:

1. **JWT validation** — Verify Ed25519 signature, check expiry, check JTI not in revoked set
2. **Policy lookup** — Find the agent's assigned `model_policies` record
3. **Alias resolution** — If requested model matches an alias key in `model_aliases` JSONB, resolve to the real model name (single-pass, no recursion)
4. **Model allowlist** — Verify resolved model is in the policy's `allowed_models` list
5. **Rate limit check** — Count requests in the current minute window against `max_requests_per_minute`
6. **Budget check** — Sum tokens used today against `max_tokens_per_day`
7. **BYOK resolution** (if user model) — Look up user model → provider connection → decrypt API key → inject into LiteLLM request
8. **Proxy to LiteLLM** — Forward request with resolved model name and (optionally) decrypted API key
9. **Usage logging** — Record `model_usage` row with token counts, cost estimate, owner, delegation_id, status

### BYOK Resolution

When an agent requests a user-owned model:

1. Look up `user_models` by model name and owner
2. Fetch the associated `provider_connections` record
3. Decrypt the `api_key_encrypted` field using AES-256-GCM with the `PROVIDER_KEY_ENCRYPTION_KEY`
4. Inject the decrypted key as `api_key` in the LiteLLM proxy request
5. After the response, ensure the decrypted key is not included in any response body

### Streaming

SSE (Server-Sent Events) passthrough for `stream: true` requests. The AI service uses `anyio.CancelScope(shield=True)` in `finally` blocks of async generators to ensure usage is logged to the database even when clients disconnect mid-stream.

### Delegation

A parent agent can create child tokens with narrowed permissions:

1. Parent requests `POST /v1/delegate` with `{label, allowed_models, max_requests_per_minute?, max_tokens_per_day?}`
2. AI service validates narrowing: child model set must be a subset of parent's effective models
3. AI service calls API service `POST /internal/delegation-token` to sign the child JWT (Ed25519 private key stays in API service only)
4. Returns child JWT to parent agent
5. On parent revocation, all child delegations are cascading-revoked

### Database Tables

All in API service PostgreSQL (`hill90`):

| Table | Purpose |
|-------|---------|
| `model_catalog` | Platform model registry (name, provider, capabilities) |
| `model_policies` | Access policies (allowed_models, rate limits, token budgets, model_aliases JSONB, created_by for user-scoped) |
| `model_usage` | Per-request usage log (agent_id, model, tokens, cost, status, owner, delegation_id) |
| `model_delegations` | Parent-child delegation records (parent_jti, child_jti, allowed_models, limits) |
| `model_router_revoked_tokens` | Revoked JWT JTIs with expiry (in-memory cache, 30s refresh) |
| `provider_connections` | User-owned provider credentials (api_key_encrypted, api_key_nonce, provider) |
| `user_models` | User-defined models referencing provider connections (name, litellm_model, connection_id) |

---

## Knowledge / AKM

The Agent Knowledge Manager is an internal-only FastAPI service that provides persistent memory for agent containers. Agents can store, retrieve, search, and assemble context from knowledge entries that survive across sessions.

### Agent-Facing Endpoints (Ed25519 JWT auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/entries` | List entries for authenticated agent (optional `?type=` filter) |
| POST | `/api/v1/entries` | Create entry with `{path, content}` |
| GET | `/api/v1/entries/{path}` | Read entry by path |
| PUT | `/api/v1/entries/{path}` | Update entry content |
| DELETE | `/api/v1/entries/{path}` | Archive entry (soft delete) |
| GET | `/api/v1/search?q=` | Full-text search across agent's entries |
| POST | `/api/v1/journal` | Append to daily journal entry (`journal/{YYYY-MM-DD}.md`) |
| GET | `/api/v1/context` | Assemble prioritized context within token budget |

### Internal Endpoints (service token auth)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/agents/refresh-token` | Rotate agent JWT using single-use refresh secret |
| POST | `/internal/revoke` | Revoke an agent JWT (called by API on agent stop) |

### Admin Endpoints (proxied by API service)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/internal/admin/agents` | List agents with entry counts |
| GET | `/internal/admin/entries?agent_id=` | List entries for a specific agent |
| GET | `/internal/admin/entries/{agent_id}/{path}` | Read a specific entry |
| GET | `/internal/admin/search?q=&agent_id=` | Search entries (optionally scoped) |

### Entry Types

Entries use frontmatter YAML with required `title` and `type` fields. Supported types:

| Type | Purpose |
|------|---------|
| `plan` | Task plans, implementation strategies |
| `decision` | Architecture decisions, design choices |
| `journal` | Daily append-only logs |
| `research` | Investigation notes, findings |
| `context` | Persistent context documents |
| `note` | General-purpose notes |

### Full-Text Search

PostgreSQL-native FTS using:
- `websearch_to_tsquery` for query parsing
- Weighted tsvector: title (weight A), body (weight B), tags (weight C)
- GIN index on `search_vector` column
- `ts_rank` scoring and `ts_headline` context extraction

### Context Assembly

`GET /api/v1/context` returns prioritized sections within a configurable token budget (default 2000 tokens, estimated at 4 chars/token):

1. Latest `context` entry (budget: 500 tokens)
2. Recent `journal` entries — last 3 days, up to 5 (budget: 500 tokens)
3. Active `plan` entries — up to 5 (budget: 500 tokens)
4. Recent `decision` entries — last 7 days, up to 5 (budget: 500 tokens)

### Reconciler

Background task running every 5 minutes (configurable via `AKM_RECONCILER_INTERVAL_SECONDS`):
- Syncs database entries to filesystem (`{AKM_DATA_DIR}/{agent_id}/{path}`)
- Detects orphaned files (filesystem entries without DB records)
- Quarantines entries that fail sync after 3 attempts (`quarantine_entries` table)
- Runs once at startup, then periodically

### Token Refresh

Agents receive a 1-hour JWT and a single-use `refresh_secret` (UUID). Before the JWT expires:
1. Agent calls `POST /internal/agents/refresh-token` with the refresh secret and current JWT
2. Service verifies the SHA256 hash of the provided secret against `agent_tokens.token_hash`
3. Old secret is invalidated, new JWT and new refresh secret are issued atomically
4. Prevents race conditions — only the first caller with a valid secret succeeds

### Database Tables

All in Knowledge service PostgreSQL (`hill90_akm`):

| Table | Purpose |
|-------|---------|
| `knowledge_entries` | Core entries (agent_id, path, title, type, body, tags, search_vector, sync_status) |
| `knowledge_links` | Reserved for future wikilink support (source_id, target_path) |
| `revoked_tokens` | Revoked JWT JTIs with expiry (30s refresh to in-memory cache) |
| `agent_tokens` | Refresh token state (jti, token_hash, rotated_from, revoked_at) |
| `quarantine_entries` | Reconciler error records (entry_id, reason, attempts, last_error) |

---

## Configuration Reference

### AI Service

**File**: `services/ai/app/config.py`

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `database_url` | `DATABASE_URL` | `postgresql://...` | PostgreSQL connection |
| `model_router_internal_service_token` | `MODEL_ROUTER_INTERNAL_SERVICE_TOKEN` | (required) | Bearer token for internal endpoints |
| `model_router_signing_public_key` | `MODEL_ROUTER_SIGNING_PUBLIC_KEY` | (required) | Ed25519 public key for JWT verification |
| `litellm_api_base` | `LITELLM_API_BASE` | `http://litellm:4000` | LiteLLM proxy URL |
| `litellm_api_key` | `LITELLM_MASTER_KEY` | (required) | LiteLLM master key |
| `provider_key_encryption_key` | `PROVIDER_KEY_ENCRYPTION_KEY` | (required) | AES-256-GCM key (64-char hex) for BYOK |

### Knowledge Service

**File**: `services/knowledge/app/config.py`

| Setting | Env Var Prefix (`AKM_`) | Default | Description |
|---------|------------------------|---------|-------------|
| `port` | `AKM_PORT` | 8002 | Service port |
| `database_url` | `AKM_DATABASE_URL` | `postgresql://.../hill90_akm` | PostgreSQL connection |
| `public_key_path` | `AKM_PUBLIC_KEY_PATH` | `/etc/akm/public.pem` | Ed25519 public key path |
| `private_key_path` | `AKM_PRIVATE_KEY_PATH` | `/etc/akm/private.pem` | Ed25519 private key path (for refresh) |
| `data_dir` | `AKM_DATA_DIR` | `/data/knowledge` | Filesystem storage root |
| `context_token_budget` | `AKM_CONTEXT_TOKEN_BUDGET` | 2000 | Token limit for context assembly |
| `internal_service_token` | `AKM_INTERNAL_SERVICE_TOKEN` | (required) | Bearer token for internal endpoints |
| `reconciler_interval_seconds` | `AKM_RECONCILER_INTERVAL_SECONDS` | 300 | Reconciler cycle interval |

### API Service (Agent-Related)

| Env Var | Description |
|---------|-------------|
| `AGENTBOX_CONFIG_HOST_PATH` | Host path for agent config bind-mounts (e.g., `/opt/hill90/agentbox-configs`) |
| `AKM_SIGNING_PRIVATE_KEY` | Ed25519 private key for signing AKM JWTs |
| `AKM_INTERNAL_SERVICE_TOKEN` | Bearer token for AKM revocation calls |
| `AKM_SERVICE_URL` | Knowledge service URL (e.g., `http://knowledge:8002`) |
| `MODEL_ROUTER_SIGNING_PRIVATE_KEY` | Ed25519 private key for signing model-router JWTs |
| `MODEL_ROUTER_INTERNAL_SERVICE_TOKEN` | Bearer token for model-router revocation calls |
| `MODEL_ROUTER_URL` | AI service URL (e.g., `http://ai:8000`) |
| `PROVIDER_KEY_ENCRYPTION_KEY` | AES-256-GCM key for encrypting provider API keys |

---

## Ownership and Access Model

### User-Scoped Resources

Resources are scoped to their creator (Keycloak `sub` claim):

| Resource | Scope Column | User Visibility | Admin Visibility |
|----------|-------------|-----------------|------------------|
| Agents | `created_by` | Own agents only | All agents |
| Provider connections | `created_by` | Own connections only | All connections |
| User models | `created_by` | Own models only | All models |
| User policies | `created_by` (where not platform) | Own + platform policies | All policies |
| Knowledge entries | `agent_id` (via JWT) | Own agents' entries (proxied) | All entries (proxied) |

### Platform Resources

| Resource | Visibility |
|----------|-----------|
| Model catalog | All users (read-only) |
| Platform policies (`created_by IS NULL`) | All users (read-only) |

### Knowledge Scoping

Knowledge entries are agent-level, not user-level. The JWT `sub` claim contains the `agent_id`, so agents can only access their own entries. Cross-agent reads return 404 (no information leakage). The API service proxies admin queries to AKM's `/internal/admin/*` endpoints, enforcing agent ownership through the API's own user-scoping logic.

---

## See Also

- [Architecture Overview](./overview.md) — System-level architecture and service inventory
- [Security Architecture](./security.md) — Agent authentication, token refresh, BYOK encryption, sandboxing
- [Secrets Architecture](./secrets-model.md) — Vault KV paths for model-router and knowledge secrets
- [Deployment Guide](../runbooks/deployment.md) — Service deployment procedures
