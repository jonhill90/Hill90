# Trust Boundaries — Principal Identity Model

This document defines the identity authorities, principal types, and token exchange rules for Hill90.

## Principal Types

| Principal type | Identity authority | Auth method | Token format | Max privilege ceiling |
|---------------|-------------------|-------------|-------------|---------------------|
| **Human** | Keycloak | OIDC (RS256) | Keycloak access token | Keycloak realm roles |
| **Agent** | API service | Ed25519 JWT | `WorkloadClaims` | Owner's role ceiling ∩ assigned skill scopes |
| **Service** | Environment | HMAC token | Bearer shared secret | Endpoint-specific (hardcoded per internal route) |

## Authority Boundaries

- **Keycloak** is authoritative for human principals. All human identity flows (login, session, role assignment) go through Keycloak.
- **API service** is authoritative for agent principals. Agent JWTs are issued by the API service using Ed25519 signing keys. Keycloak has no representation of agents (Option C — see design decision below).
- **Service tokens** are environment-scoped shared secrets for internal service-to-service calls. They are not issued dynamically.

## Token Exchange Rules

**Hard prohibition**: No cross-authority token exchange.

- An agent token cannot be exchanged for a Keycloak (human) token.
- A human token cannot be exchanged for an Ed25519 (agent) token.
- A service token cannot be exchanged for either.

Agents act **as themselves**. The `owner` claim in agent JWTs is for audit attribution only — it does not grant the agent the owner's privileges. Agent privilege is derived from the intersection of the owner's current roles and the agent's assigned skill scopes, computed at token issuance time.

## Agent Token Contract (WorkloadClaims)

All agent tokens conform to the `WorkloadClaims` interface (defined in `services/api/src/types/workload-claims.ts`):

**Required claims:**

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | string | Principal ID — agent UUID (V2) or slug (V1) |
| `principal_type` | `'agent'` | Formal principal type |
| `iss` | string | Always `hill90-api` |
| `aud` | string | Target audience (e.g., `hill90-akm`, `hill90-model-router`) |
| `exp` | number | Expiration (epoch seconds) |
| `iat` | number | Issued-at (epoch seconds) |
| `jti` | string | Unique token ID (revocation handle) |
| `owner` | string | Keycloak sub of owning human |
| `scopes` | string[] | Flat colon-namespaced scopes (e.g., `['akm:read', 'inference:chat']`) |

**Optional claims:**

| Claim | Type | Description |
|-------|------|-------------|
| `correlation_id` | string | Request-scoped tracing ID |
| `agent_slug` | string | Human-readable agent_id (V2 only, for log correlation) |

## RBAC Scope Boundaries

- Agent scopes = intersection of (owner's current Keycloak roles) ∩ (assigned skill scopes).
- Agent cannot escalate beyond owner's ceiling.
- If owner loses `admin` role, agent start with elevated skills is rejected (403).
- Elevated scope assignment (`host_docker`, `vps_system`) requires admin role.
- Scope is computed at token issuance (start time). Mid-flight changes require agent restart.

## Migration Window (V1 → V2)

When `WORKLOAD_PRINCIPAL_V2=true` on the API service:
- `sub` changes from agent slug to agent UUID.
- `agent_slug` claim is added for backward-compatible log correlation.
- `principal_type` and `scopes` are always present regardless of flag.

**Downstream verification services** should accept both slug and UUID formats for `sub` during the migration window (default: 7 days from first V2 deploy, configurable via `WORKLOAD_PRINCIPAL_MIGRATION_DEADLINE` env var).

After the migration window, downstream services should enforce UUID-only `sub`.

## Keycloak Strategy Decision

**Chosen: Option C — No Keycloak representation for agents.**

Agents remain API-issued Ed25519 principals. Keycloak is not the identity provider for agents.

Rationale:
- Hill90 has <100 agents; Keycloak service account overhead is not justified.
- Agent tokens are short-lived (1h), infrastructure-scoped, and revocable.
- Adding Keycloak service accounts creates a management surface with no current consumer.

Upgrade path: If OIDC federation is needed in the future, migrate to Option A (service account per agent) in a new work item.

## Threat Assumptions

- Ed25519 signing keys are stored in SOPS/Vault, not in application code.
- Agent tokens have 1-hour TTL to limit blast radius of key compromise.
- JTI-based revocation is DB-backed and survives service restart.
- Clock skew tolerance is 30 seconds.
- No token reuse across agent restarts (new JTI per start).
