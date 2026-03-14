# Agent Identity Model

> Canonical reference for Hill90's three principal types, token formats, auth boundaries, and anti-patterns.
>
> **Source files**: `services/api/src/middleware/auth.ts`, `services/api/src/services/akm-token.ts`, `services/api/src/services/model-router-token.ts`, `services/ai/app/auth.py`, `services/knowledge/app/middleware/agent_auth.py`. If these files are refactored, this document should be reviewed for drift.

## 1. Principal Types

Hill90 has three distinct principal types. Each uses a structurally incompatible authentication mechanism, preventing cross-boundary impersonation.

### Human Users

Human operators authenticated via Keycloak OpenID Connect.

- **Token format**: RS256 JWT, signed by Keycloak JWKS
- **Required header**: `kid` (Key ID) — used to resolve the signing key from JWKS endpoint
- **Issuer**: `https://auth.hill90.com/realms/hill90`
- **Key claims**: `sub` (user UUID), `realm_roles` (array), `exp`, `iat`
- **Verification**: `services/api/src/middleware/auth.ts` — `createRequireAuth()` validates RS256 algorithm + issuer + kid resolution
- **Authorization**: `services/api/src/middleware/role.ts` — reads `realm_roles` array for RBAC

### Agent Workload Principals

Autonomous agent containers authenticated via Ed25519 JWTs issued by the API service.

- **Token format**: EdDSA JWT (Ed25519), signed by API service private key
- **Issuer**: `hill90-api`
- **Audiences**: `hill90-akm` (Knowledge service) or `hill90-model-router` (AI service)
- **Key claims**: `sub` (agent_id slug), `owner` (creating user's UUID), `jti` (for revocation), `exp`, `iat`
- **Lifecycle**: Issued at agent start, revoked at agent stop (JTI blacklisted)
- **Verification**:
  - Knowledge service: `services/knowledge/app/middleware/agent_auth.py` — EdDSA + issuer + audience
  - AI service: `services/ai/app/auth.py` — EdDSA + issuer + audience

### Service Principals

Internal service-to-service communication authenticated via shared secret bearer tokens.

- **Token format**: Opaque UUID strings, compared timing-safe
- **Verification**: Per-endpoint middleware with `timingSafeEqual`
- **No JWT claims**: Service tokens carry no identity beyond "authenticated service"
- **Scope**: Each token authorizes a specific source → target path (see Service Account Inventory below)

## 2. Token Format Reference

| Principal Type | Algorithm | Issuer | Audience | Key Claims | Verification Location |
|---------------|-----------|--------|----------|------------|----------------------|
| Human User | RS256 | Keycloak realm | N/A | `sub`, `realm_roles` | `middleware/auth.ts` |
| Agent (AKM) | EdDSA | `hill90-api` | `hill90-akm` | `sub`, `owner`, `scopes`, `jti` | `knowledge/agent_auth.py` |
| Agent (Model Router) | EdDSA | `hill90-api` | `hill90-model-router` | `sub`, `owner`, `jti` | `ai/auth.py` |
| Agent (Delegation) | EdDSA | `hill90-api` | `hill90-model-router` | `sub`, `owner`, `delegation_id`, `parent_jti`, `jti` | `ai/auth.py` |
| Service | N/A (opaque) | N/A | N/A | None | Per-endpoint handler |

## 3. Auth Boundaries

The structural separation between principal types is enforced by incompatible cryptographic algorithms and claim requirements:

```
Human (RS256 + kid)  ──►  API Service requireAuth()
                              │
                              ├── Requires RS256 algorithm
                              ├── Requires kid header for JWKS lookup
                              └── Validates Keycloak issuer

Agent (EdDSA)        ──►  AI Service / Knowledge Service
                              │
                              ├── Requires EdDSA algorithm
                              ├── No kid header expected
                              ├── Validates 'hill90-api' issuer
                              └── Validates service-specific audience

Service (opaque)     ──►  /internal/* endpoints
                              │
                              ├── Registered BEFORE requireAuth middleware
                              ├── Timing-safe string comparison
                              └── Per-endpoint token matching
```

**Why cross-auth is impossible**:
- An agent EdDSA token presented to `requireAuth()` fails because: (1) wrong algorithm (EdDSA vs RS256), (2) no `kid` header, (3) wrong issuer
- A Keycloak RS256 token presented to `verify_model_router_token()` fails because: (1) wrong algorithm (RS256 vs EdDSA), (2) wrong issuer
- Service tokens are routed to separate middleware before `requireAuth()` runs — no overlap

These boundaries are verified by tests in `auth-boundary.test.ts` (AB-1/2/3) and `test_auth.py` (AB-4).

## 4. Owner Attribution Chain

Every agent action traces back to the human who created it:

```
Human User (sub: user-uuid)
    │
    ├── Creates agent (agents.created_by = user-uuid)
    │
    ├── Starts agent → API issues tokens:
    │       ├── AKM token: owner = agent.created_by
    │       └── Model-router token: owner = agent.created_by
    │
    └── Agent runs → tokens carry owner claim:
            ├── Knowledge service: scoped queries via owner claim
            ├── AI service: AgentClaims.owner for attribution
            └── Audit logs: user_sub + principal_type trace the chain
```

**Known limitation**: Delegation tokens (child agents created via `POST /v1/delegate`) do not currently carry the `owner` claim from the parent. The AI service resolves ownership via DB lookup from the parent's delegation record. This is documented as future hardening — not a security gap, as delegation enforcement is handled server-side.

## 5. Service Account Inventory

| Token | Env Var | Source Service | Target Service | Target Path | Rotation |
|-------|---------|---------------|----------------|-------------|----------|
| AKM internal service token | `AKM_INTERNAL_SERVICE_TOKEN` | API | Knowledge | `/internal/*` | Via vault seed |
| Model-router internal service token | `MODEL_ROUTER_INTERNAL_SERVICE_TOKEN` | API, AI | AI | `/internal/*` | Via vault seed |
| Chat callback token | `CHAT_CALLBACK_TOKEN` | Agentbox | API | `/internal/chat/callback` | Via vault seed |
| AKM signing private key | `AKM_SIGNING_PRIVATE_KEY` | API (signer) | Knowledge (verifier via public key) | JWT payload | Key rotation via vault |
| Model-router signing private key | `MODEL_ROUTER_SIGNING_PRIVATE_KEY` | API (signer) | AI (verifier via public key) | JWT payload | Key rotation via vault |

All secrets are stored in OpenBao vault and injected at deploy time. SOPS serves as bootstrap/DR backup. See [Secrets Architecture](./secrets-model.md).

## 6. Anti-Patterns

### Agent-as-Human-User (Structurally Prevented)

**Anti-pattern**: Giving an agent container a Keycloak credential (client_id/secret or user password) so it can call API routes directly as a "user."

**Why it's prevented**:
1. Agent tokens use EdDSA — they cannot pass `requireAuth()` which requires RS256 + kid
2. API routes read `realm_roles` from Keycloak JWT — agent tokens have no roles
3. Agent containers receive only explicitly injected env vars (AKM token, model-router token, work token, chat callback token) — no Keycloak credentials are ever injected

**Correct pattern**: Agents interact with platform services via their Ed25519 JWTs (Knowledge, AI services). The API service acts on behalf of agents only through internal service endpoints.

### Service-Token-as-Identity (Avoid)

Service tokens authenticate the calling service, not a specific user or agent. When a service-initiated action needs attribution (e.g., `elevated_agent_response` audit log), the code must pass the relevant agent/user ID explicitly — the service token itself carries no identity.

The `auditLog()` function enforces this by requiring a `principalType` parameter (`'human' | 'agent' | 'service'`) alongside the `userSub`, preventing conflation of service identity with user identity.

## 7. Cross-References

- [Security Architecture](./security.md) — network segmentation, container isolation, service token table
- [Secrets Architecture](./secrets-model.md) — vault paths, SOPS backup, rotation procedures
- [Architecture Overview](./overview.md) — system topology and service interactions
