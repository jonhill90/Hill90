# Secrets Vault UI — Design Document

**Linear:** AI-113 | **Date:** 2026-04-04 | **Status:** Design complete

## Executive Summary

Design a least-privilege admin UI surface for secrets management that provides read-only visibility, controlled rotation, sync operations, and audit trail — without ever exposing raw secret values in the browser. The UI complements (not replaces) the existing CLI tooling and the native OpenBao web UI.

---

## Current State

### Secrets Infrastructure

Hill90 uses a **vault-first with SOPS fallback** model:
- **OpenBao** (port 8200): Runtime source of truth. 14 KV v2 paths, 13 policies, 9 AppRoles, OIDC SSO
- **SOPS** (age encryption): Bootstrap and disaster recovery backup. 27 runtime keys + bootstrap keys + vault management keys
- **Vault → SOPS sync**: `vault.sh sync-to-sops` (CLI or weekly GitHub Actions workflow)

### What's CLI-Only Today

| Operation | Tool | Who | Frequency |
|-----------|------|-----|-----------|
| View secret values | `secrets.sh view` / OpenBao UI | Admin (SSH or OIDC) | Occasional |
| Update a secret | `bao kv patch` + redeploy | Admin (SSH) | Rare |
| Rotate AppRole secret_id | `vault.sh bootstrap-approles` | Admin (SSH) | Very rare |
| Trigger vault → SOPS sync | `vault.sh sync-to-sops` | Admin (SSH) or CI | Weekly automated, manual on drift |
| View audit trail | `docker logs openbao` | Admin (SSH) | On investigation |
| Check vault status | `vault.sh status` | Admin (SSH) | On incident |

### What the UI Already Has

- Health check for OpenBao via admin services dashboard
- Link to `https://vault.hill90.com` (OIDC login)
- No secrets management, no audit visualization

---

## Design Principles

1. **Never render raw secret values in the browser.** Values are masked (`••••••••`) by default. A "reveal" action copies to clipboard with a 10-second auto-clear — the value never appears in DOM text content.
2. **Admin-only.** All secrets UI routes require `admin` role. No user-level access.
3. **Read-heavy, write-rare.** The primary use case is visibility ("what secrets exist, when were they last rotated"). Writes are exceptional operations.
4. **Audit everything.** Every view, reveal, update, and sync operation logs to the application audit trail with user attribution.
5. **Vault-first.** The UI reads from vault, not SOPS. SOPS is the backup, not the source.

---

## Security Model

### Authentication & Authorization

```
Browser → API (Keycloak JWT, admin role required)
  └── API → OpenBao (AppRole: policy-api, read-only)
        └── For writes: API generates temporary vault token via OIDC on behalf of admin
```

**Read path:** API service uses its existing `policy-api` AppRole (read-only access to `secret/shared/*`, `secret/api/*`, `secret/knowledge/*`). For paths outside API's scope, a new `policy-secrets-ui` policy grants read-list on all `secret/*` paths.

**Write path:** Updates require elevated vault access. Two options:
- **(A) Proxy through API with admin OIDC token**: Admin's Keycloak token is exchanged for a vault OIDC token, scoped to `policy-oidc-admin`. API proxies the write call. Token is ephemeral.
- **(B) Direct vault UI**: For complex operations, redirect admin to `vault.hill90.com` with OIDC SSO. No API involvement.

**Recommendation:** Option A for simple key rotation (single-value update). Option B for multi-key operations, policy changes, or anything requiring vault UI features.

### Value Masking Contract

| Context | Behavior |
|---------|----------|
| API response | Values replaced with `"••••••••"` (8 bullets). Metadata (key name, version, last updated) returned in full. |
| Reveal action | `POST /admin/secrets/:path/reveal?key=KEY` returns the raw value. Logged as `secret_reveal` audit event with key name + admin sub. Rate-limited: 10 reveals per minute per admin. |
| Clipboard copy | Frontend copies revealed value to clipboard, clears after 10 seconds. Value never written to DOM textContent. |
| Audit log | Secret values NEVER appear in audit entries. Only key names, paths, and action types. |

### New Vault Policy

```hcl
# policy-secrets-ui.hcl — read-list for secrets UI surface
path "secret/data/*" {
  capabilities = ["read", "list"]
}
path "secret/metadata/*" {
  capabilities = ["read", "list"]
}
```

This policy is assigned to a new AppRole (`secrets-ui`) used by the API service specifically for secrets UI operations. It is separate from `policy-api` to maintain least-privilege on the existing API AppRole.

---

## Wireframe Descriptions

### Page: `/admin/secrets` (Secrets Overview)

**Layout:** Full-width admin page within AppShell. Admin-only (redirects non-admin).

**Header:**
- Title: "Secrets"
- Subtitle: "Vault secrets inventory and management"
- Status badge: "Vault: Sealed/Unsealed/Unavailable" (live from `/v1/sys/health`)
- "Sync to SOPS" button (top right, admin action)

**Vault Status Bar** (below header, full-width):
- Seal status indicator (green unsealed / red sealed)
- Vault version
- Last SOPS sync timestamp (from metadata or file mtime)
- Cluster name

**Secrets Table:**

| Column | Content |
|--------|---------|
| Path | `secret/shared/database` (monospace, clickable to expand) |
| Keys | Key count badge (e.g., "3 keys") |
| Last Updated | Relative time from vault metadata version timestamp |
| Consumers | Service badges (e.g., `api` `ai` `knowledge`) from schema |

**Expand row** (click path → inline expand):
- Key list table within the row:

  | Key | Value | Version | Actions |
  |-----|-------|---------|---------|
  | DB_PASSWORD | `••••••••` | v3 | Reveal / Copy / Rotate |
  | DB_USER | `••••••••` | v3 | Reveal / Copy |
  | DB_NAME | `••••••••` | v1 | Reveal / Copy |

- "Reveal" button: loads value from API, copies to clipboard, shows toast "Copied — clears in 10s"
- "Rotate" button: opens rotate modal (see below)
- Version number from vault KV v2 metadata

**Empty state:** "Vault is sealed or unreachable. Unseal via CLI: `bash scripts/vault.sh unseal`"

### Modal: Rotate Secret

**Trigger:** "Rotate" button on a key row.

**Content:**
- Title: "Rotate Secret"
- Path: `secret/shared/database` (read-only)
- Key: `DB_PASSWORD` (read-only)
- Current value: `••••••••` (masked, reveal available)
- New value: text input (password field, toggle visibility)
- "Generate" button: generates a random 32-char base64 value client-side
- Warning: "Rotating this secret requires redeploying: `api`, `ai`, `knowledge`" (consumers from schema)
- Checkbox: "I understand affected services must be redeployed"
- Actions: Cancel / Rotate

**On confirm:**
1. `PUT /admin/secrets/:path` with `{ key, value }`
2. API updates vault KV via elevated OIDC token
3. Audit log: `secret_rotate` with path + key + admin sub
4. Toast: "Secret rotated. Redeploy affected services."
5. Does NOT auto-redeploy (manual step per AGENTS.md deploy rules)

### Page: `/admin/secrets/audit` (Audit Trail)

**Layout:** Admin page with filterable log table.

**Filters:**
- Date range (from/to pickers, default last 7 days)
- Action type: dropdown (all, reveal, rotate, sync, view)
- Path: text filter
- User: text filter

**Audit Table:**

| Column | Content |
|--------|---------|
| Timestamp | ISO 8601 |
| Action | `secret_reveal` / `secret_rotate` / `secret_sync` / `secret_view` |
| Path | `secret/shared/database` |
| Key | `DB_PASSWORD` (or `—` for path-level ops) |
| User | Keycloak display name + sub |

**Data source:** Application audit log (`auditLog()` entries), NOT vault audit log. Vault audit is too noisy (includes health checks, token renewals). The UI logs only user-initiated secrets operations.

### Page: `/admin/secrets/sync` (Sync Status)

**Layout:** Simple status page.

**Content:**
- Last vault → SOPS sync: timestamp + "Success" / "Failed" badge
- Last SOPS → vault seed: timestamp (from deploy log)
- Schema drift status: "Clean" or "N drift issues" (from `check_secrets_schema.py` output)
- "Run Sync Now" button: triggers `vault.sh sync-to-sops` via SSH (same pattern as deploy)
- Sync history: last 5 sync events with timestamp + status

---

## API Routes (New)

All under `/admin/secrets` prefix, `requireRole('admin')`.

| Method | Path | Purpose | Vault Access |
|--------|------|---------|--------------|
| `GET` | `/admin/secrets` | List all paths with metadata (key count, version, consumers) | `policy-secrets-ui` (read-list) |
| `GET` | `/admin/secrets/:path` | List keys under a path with masked values + metadata | `policy-secrets-ui` (read) |
| `POST` | `/admin/secrets/:path/reveal` | Return raw value for a single key (audit-logged) | `policy-secrets-ui` (read) |
| `PUT` | `/admin/secrets/:path` | Update a single key (rotate) | Elevated OIDC token (write) |
| `GET` | `/admin/secrets/audit` | Query application audit log for secrets actions | Database (no vault) |
| `GET` | `/admin/secrets/status` | Vault seal status + sync status | `sys/health` (unauthenticated) |
| `POST` | `/admin/secrets/sync` | Trigger vault → SOPS sync | VPS SSH (same pattern as deploy) |

### Rate Limits

| Action | Limit | Window |
|--------|-------|--------|
| Reveal | 10 per admin | 1 minute |
| Rotate | 5 per admin | 5 minutes |
| Sync | 1 | 10 minutes (global) |

---

## Audit Actions

| Action | When | Logged Fields |
|--------|------|---------------|
| `secret_view` | Admin opens secrets page or expands a path | `path` |
| `secret_reveal` | Admin reveals a specific key value | `path`, `key` |
| `secret_rotate` | Admin updates a key via rotate modal | `path`, `key` (NOT value) |
| `secret_sync` | Admin triggers vault → SOPS sync | `trigger: manual` |
| `secret_sync_auto` | Weekly GitHub Actions sync | `trigger: scheduled` |

All actions include: `admin_sub` (Keycloak sub), `timestamp`, `ip` (from request).

---

## Data Flow

### Read (Masked List)

```
Browser → GET /admin/secrets/shared/database
  → API (admin JWT verified)
    → OpenBao GET /v1/secret/data/shared/database (AppRole: policy-secrets-ui)
      ← { data: { DB_PASSWORD: "real", DB_USER: "real" }, metadata: { version: 3, ... } }
    → API masks values: { DB_PASSWORD: "••••••••", DB_USER: "••••••••" }
    → auditLog('secret_view', { path: 'shared/database' })
  ← Browser renders masked table
```

### Reveal (Single Key)

```
Browser → POST /admin/secrets/shared/database/reveal { key: "DB_PASSWORD" }
  → API (admin JWT verified, rate limit check)
    → OpenBao GET /v1/secret/data/shared/database (AppRole: policy-secrets-ui)
      ← { data: { DB_PASSWORD: "actual-secret-value" } }
    → API returns only the requested key's value (not all keys)
    → auditLog('secret_reveal', { path: 'shared/database', key: 'DB_PASSWORD' })
  ← Browser copies to clipboard, auto-clears 10s
```

### Rotate (Write)

```
Browser → PUT /admin/secrets/shared/database { key: "DB_PASSWORD", value: "new-value" }
  → API (admin JWT verified, rate limit check)
    → API obtains vault OIDC token using admin's Keycloak session
    → OpenBao PATCH /v1/secret/data/shared/database (OIDC token: policy-oidc-admin)
      ← { metadata: { version: 4 } }
    → auditLog('secret_rotate', { path: 'shared/database', key: 'DB_PASSWORD' })
  ← Browser shows "Rotated. Redeploy: api, ai, knowledge"
```

---

## What This Design Does NOT Cover

- **Policy management** — vault policies are code-managed HCL files. No UI for creating/editing policies.
- **AppRole credential rotation** — complex multi-step process (revoke old, issue new, update SOPS, redeploy). Stays CLI-only.
- **Unseal key management** — stored on VPS host. Cannot be exposed through UI.
- **SOPS key management** — age keypairs managed via `secrets.sh init`. CLI-only.
- **Cross-environment secrets** — only prod vault is in scope. Dev/staging are separate.
- **Auto-redeploy after rotation** — intentionally manual per AGENTS.md guardrails (no `--admin` or `--force` deploy).

---

## Implementation Estimate

| Phase | Scope | Effort |
|-------|-------|--------|
| 1. API routes + vault integration | `GET` list/detail (masked), reveal, status | 3-4 days |
| 2. UI pages | Secrets overview table, expand rows, reveal/copy, status bar | 3-4 days |
| 3. Rotate flow | `PUT` route, OIDC token exchange, rotate modal, consumer warnings | 2-3 days |
| 4. Audit trail | Audit actions, audit page with filters | 2 days |
| 5. Sync UI | Status page, trigger sync, history | 1-2 days |
| **Total** | | **11-15 days** |

### Prerequisites

- New vault policy `policy-secrets-ui` (read-list on `secret/*`)
- New AppRole `secrets-ui` for API service (or extend existing `policy-api`)
- Schema data (`secrets-schema.yaml`) parsed by API for consumer mappings

---

## Decision

This is a design document. Implementation is gated on:
1. Approval of this design
2. Prioritization against other backlog items
3. Decision on Phase 1 vs full implementation

**Recommendation:** Start with Phase 1 (read-only masked list + reveal) — it covers 80% of the operational need (visibility) with minimal security surface.
