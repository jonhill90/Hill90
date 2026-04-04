# MCP Gateway Strategy Evaluation

**Linear:** AI-114 | **Date:** 2026-04-04 | **Status:** Research complete

## Executive Summary

**Recommendation: Keep per-service architecture. Do not build a centralized MCP gateway.**

The current MCP service (`services/mcp/`) is a JWT auth gateway shell — the MCP SDK is imported but unused, no tools or resources are defined, and agents do not use MCP protocol at all. Building a gateway would add complexity without solving a real problem. The per-service direct-call pattern (agents → AI service, agents → Knowledge service) is simpler, faster, and already working.

---

## Current State

### MCP Service (`services/mcp/`)

| Aspect | State |
|--------|-------|
| Framework | FastAPI + uvicorn (port 8001) |
| MCP SDK | `mcp ^0.9.1` imported but **unused** — no tools, resources, or prompts defined |
| Authentication | Keycloak RS256 JWT validation via JWKS |
| Routes | `GET /health`, `GET /me` (JWT echo) |
| Public URL | `https://ai.hill90.com/mcp` (Traefik path-strip) |
| Networks | `edge` (public) + `internal` (service mesh) |
| Observability | OpenTelemetry → Tempo |
| Agent usage | **None** — agents call AI and Knowledge services directly |
| Tests | 7 tests (auth pipeline + basic routes) |

### How Agents Access Services Today

```
Agent Container (agentbox)
  ├── AI Service (:8000)     — Ed25519 JWT, /v1/chat/completions, /v1/embeddings
  ├── Knowledge (:8002)      — Ed25519 JWT, /api/v1/entries, /api/v1/search
  └── (No MCP involvement)
```

Agents use **plain HTTP with Ed25519 JWTs** — not MCP protocol. The AI service handles model routing, policy enforcement, BYOK resolution, and LiteLLM proxying. The Knowledge service handles entries, search, context assembly, and journal. Both have well-defined internal APIs with full test coverage.

### External MCP Access

The only external MCP endpoint is `https://ai.hill90.com/mcp`, which currently only validates JWTs and echoes claims. No external client uses it for MCP protocol operations.

---

## Options Evaluated

### Option A: Build a Centralized MCP Gateway

**Concept:** Single MCP server that exposes all platform capabilities (inference, knowledge, shell, filesystem) as MCP tools/resources. External MCP clients (Claude Desktop, VS Code Copilot, etc.) connect to one endpoint and get unified tool access.

**Architecture:**
```
External MCP Client
  └── MCP Gateway (ai.hill90.com/mcp)
        ├── Tool: chat_completion → AI Service
        ├── Tool: search_knowledge → Knowledge Service
        ├── Tool: create_entry → Knowledge Service
        ├── Resource: agent/{id}/events → API Service
        └── (Auth: Keycloak JWT → scoped access)
```

**Pros:**
- Single endpoint for external MCP clients
- Centralized auth and rate limiting
- Could expose platform capabilities to IDE integrations

**Cons:**
- **Adds a proxy hop** — MCP Gateway → internal service → provider. Latency increases.
- **Duplicates API surface** — every tool wraps an existing internal endpoint. Two places to maintain.
- **MCP protocol overhead** — SSE transport, tool registration, JSON-RPC framing for what are already REST calls
- **Security surface expansion** — public endpoint with write access to knowledge, inference budget consumption
- **No current consumer** — no external client needs this today
- **Agent containers don't use MCP** — they were migrated OFF MCP (Phase 3 removal complete). Re-adding MCP at the gateway level doesn't serve agents.

**Effort:** 2-3 weeks (tool definitions, auth scoping, SSE transport, tests, deployment)

### Option B: Keep Per-Service Architecture (Recommended)

**Concept:** Each service maintains its own API. Agents call services directly. The MCP service remains as a minimal auth gateway, activated only when an external MCP client use case materializes.

**Architecture (unchanged):**
```
Agent Container → AI Service (:8000)        [Ed25519 JWT, direct HTTP]
Agent Container → Knowledge Service (:8002) [Ed25519 JWT, direct HTTP]
External Client → API Service (:3000)       [Keycloak JWT, REST]
MCP Service (:8001)                         [Keycloak JWT, dormant]
```

**Pros:**
- **Zero new work** — already working, tested, deployed
- **Lower latency** — agents talk directly to services, no proxy hop
- **Simpler security model** — Ed25519 JWTs scoped per-agent, per-service. No aggregation risk.
- **Independent scaling** — each service scales independently
- **No MCP protocol tax** — REST is simpler than JSON-RPC + SSE for internal calls
- **Agents explicitly don't need MCP** — the Phase 3 migration removed all MCP from agentbox

**Cons:**
- External MCP clients can't access the platform (but none need to today)
- If MCP becomes a requirement for IDE integrations, work is deferred (but not wasted — the MCP service shell exists)

**Effort:** None.

### Option C: Lightweight MCP Tool Definitions (Future, If Needed)

**Concept:** When an external consumer appears (e.g., Claude Desktop integration, VS Code MCP plugin), add tool definitions to the existing MCP service shell. No gateway pattern — just activate the dormant MCP SDK.

**What this would look like:**
- Define 3-5 MCP tools in `services/mcp/app/tools/` wrapping existing API calls
- Use Keycloak JWT for auth (already working)
- SSE transport on the existing public endpoint
- Scope tools per-user based on JWT claims

**Effort:** 3-5 days when needed. Not needed now.

---

## Security Analysis

### Centralized Gateway Risks

| Risk | Impact | Notes |
|------|--------|-------|
| Single point of failure for all MCP access | High | Gateway down = all external MCP clients disconnected |
| Aggregated auth scope | High | One compromised JWT could access inference + knowledge + events |
| Write access amplification | Medium | MCP tools with write ops (create_entry, chat_completion) exposed on public endpoint |
| Token confusion | Medium | Keycloak JWTs (external) vs Ed25519 JWTs (agent) — gateway must translate between the two |
| Rate limit bypass | Medium | Gateway must enforce per-user limits independently of per-agent limits in AI service |

### Per-Service Security (Current)

| Property | State |
|----------|-------|
| Agent auth | Ed25519 JWTs with per-agent scoping, 1h expiry, refresh rotation |
| External auth | Keycloak RS256 JWTs, user-scoped |
| Network isolation | Agents on sandbox/internal networks, no public access |
| Service-level rate limits | AI service enforces per-agent rate + budget limits |
| No token translation needed | Each service validates its own token type |

**Verdict:** Per-service architecture has better security properties. No aggregation risk, no token translation, clear trust boundaries.

---

## Decision

**Keep per-service architecture (Option B).** Activate MCP tool definitions (Option C) only when an external consumer materializes.

### Rationale

1. **No consumer exists** — no external MCP client needs platform access today
2. **Agents don't use MCP** — they were explicitly migrated off MCP in the agentbox Phase 3 rewrite
3. **Gateway adds complexity without solving a problem** — it would be a proxy layer over existing REST APIs
4. **Security is better without centralization** — per-service auth with scoped tokens is the stronger model
5. **The MCP service shell is ready** — when a consumer appears, activating tools in the existing shell is 3-5 days of work, not a greenfield build

### Action Items

- [ ] **No implementation needed** — this is an evaluation, not a build
- [ ] Update AI-114 to Done in Linear
- [ ] Consider removing the unused `mcp ^0.9.1` dependency from `pyproject.toml` to reduce image size (optional cleanup, separate ticket)
- [ ] If an external MCP consumer appears in future, open a new ticket for Option C (lightweight tool definitions)

---

## Appendix: MCP Service File Inventory

| File | Purpose |
|------|---------|
| `services/mcp/app/main.py` | FastAPI app, JWKS setup, `/health` + `/me` routes |
| `services/mcp/app/middleware/auth.py` | JWT verification dependency factory |
| `services/mcp/Dockerfile` | python:3.12-slim, port 8001, OTEL-instrumented uvicorn |
| `services/mcp/pyproject.toml` | FastAPI, MCP SDK, python-jose, OTEL deps |
| `deploy/compose/prod/docker-compose.mcp.yml` | Edge + internal networks, Traefik path routing |
| `.github/workflows/deploy-mcp.yml` | Manual deploy dispatch |
| `platform/edge/dynamic/middlewares.yml` | `mcp-strip` prefix middleware |
