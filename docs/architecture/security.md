# Security Architecture

Hill90 uses layered controls to keep public services reachable while restricting administration and service-to-service paths.

## Access Boundaries

- Public internet access is limited to HTTP/HTTPS entrypoints handled by Traefik.
- Administrative surfaces (Traefik dashboard, Portainer, and MinIO console) are reachable only through Tailscale.
- SSH access is restricted to the Tailscale CIDR (`100.64.0.0/10`) via firewall rules.

## Identity And Secrets

- SSH uses key-based authentication only; password auth and root login are disabled.
- **OpenBao vault is the runtime source of truth for secrets.** SOPS + age serves as bootstrap and disaster-recovery backup. Deploy is vault-first with SOPS fallback.
- Each service authenticates to vault via AppRole and reads only its assigned KV paths.
- Vault auto-unseals on boot via a systemd oneshot service; the unseal key is stored on the host at `/opt/hill90/secrets/openbao-unseal.key` with 0600 permissions.
- SOPS-encrypted secrets (`infra/secrets/prod.enc.env`) are decrypted only at deploy/runtime and not committed in plaintext.
- Vault-to-SOPS sync runs weekly via GitHub Actions to keep the SOPS backup current.
- See [Secrets Architecture](./secrets-model.md) for the full vault model.

## Application Authentication

- Keycloak 26.4 serves as the identity provider at auth.hill90.com (OIDC/OAuth2).
- Auth.js v5 manages browser sessions in the UI and handles the authorization code flow.
- API (Express) and MCP (FastAPI) validate Keycloak-issued JWTs on protected routes.
- The hill90 realm disables self-registration and enables brute force detection.
- Keycloak admin console is credential-protected with MFA capability.

## Email / SMTP

- Keycloak sends transactional email (password resets, verification) via Hostinger SMTP relay (`smtp.hostinger.com:587`, STARTTLS).
- Sender address: `noreply@hill90.com`.
- `SMTP_PASSWORD` is stored in SOPS (`infra/secrets/prod.enc.env`) and injected into the Keycloak realm via the `setup-realm.sh` phase1 REST API call — it is not a Docker environment variable.
- DNS email authentication: SPF (`v=spf1 include:_spf.hostinger.email ~all`), DKIM (hostingermail CNAME records), and DMARC (`v=DMARC1; p=none`).

## Agent Authentication

The agent harness uses two independent Ed25519 key pairs to authenticate agent containers with internal services. Both private keys are held exclusively by the API service and used to sign JWTs at agent start.

**Model-router key pair** (AI service):
- Signs JWTs with claims: `sub` (agent_id), `iss`, `aud`, `exp`, `iat`, `jti`
- Verified by the AI service using the corresponding public key
- Revoked on agent stop via `POST /internal/revoke` (JTI blacklisted)
- In-memory revocation cache refreshed every 30 seconds from `model_router_revoked_tokens` table

**AKM key pair** (Knowledge service):
- Signs JWTs with claims: `sub` (agent_id), `iss`, `aud`, `exp`, `iat`, `jti`, `scopes`
- Verified by the Knowledge service using the corresponding public key
- Revoked on agent stop via `POST /internal/revoke` (JTI blacklisted)
- In-memory revocation cache refreshed every 30 seconds from `revoked_tokens` table
- Includes single-use refresh secret for token rotation (see below)

**Delegation tokens** (child agents):
- Signed by the API service via `POST /internal/delegation-token` (called by AI service)
- Carry `delegation_id` and `parent_jti` claims in addition to standard fields
- Allowed models must be a subset of the parent agent's effective model set
- Cascading revocation: revoking a parent JTI invalidates all child delegations

## AKM Token Refresh

Agent JWTs have a 1-hour expiry. The AKM token includes a single-use refresh mechanism:

1. At agent start, the API service generates a UUID `refresh_secret` and injects it into the agent container
2. The Knowledge service stores the SHA256 hash of the secret in `agent_tokens.token_hash`
3. Before JWT expiry, the agent calls `POST /internal/agents/refresh-token` with the current JWT and refresh secret
4. The service verifies the hash, issues a new JWT + new refresh secret, and invalidates the old secret atomically
5. Only the first caller with a valid secret succeeds — prevents race conditions in concurrent refresh attempts
6. Revoked JTIs cannot refresh even with a valid secret

## BYOK Trust Boundaries

User-provided API keys (Bring Your Own Key) are encrypted at rest and handled with strict trust boundaries:

- **At rest**: Provider connection API keys are encrypted with AES-256-GCM before storage in `provider_connections.api_key_encrypted` (with per-row nonce in `api_key_nonce`)
- **Encryption key**: 64-character hex key stored in vault at `secret/shared/model-router`, injected as `PROVIDER_KEY_ENCRYPTION_KEY` to both API and AI services
- **In transit**: Decrypted keys exist only in AI service memory during request processing
- **Post-proxy**: After LiteLLM forwards the request to the provider, the AI service scrubs the decrypted key from memory and ensures it does not appear in response bodies
- **Network boundary**: Decrypted keys never leave the `internal` network — agents on `agent_internal` send model names, not API keys
- **API responses**: The `api_key_encrypted` and `api_key_nonce` fields are never returned in API responses

## Agentbox Sandboxing

Agent containers run in a sandboxed environment with multiple isolation layers:

- **Non-root user**: `agentuser` (UID 1000) — prevents privilege escalation
- **Network isolation**: Agents are placed on `hill90_agent_sandbox` (default) or `hill90_agent_internal` (elevated scopes only) based on their assigned skill scopes. Neither network grants access to the Docker socket proxy, edge network, or public internet.
- **Environment stripping**: Agent containers receive only `PATH`, `HOME`, `LANG`, `TERM`, plus explicitly injected service tokens — no inherited secrets from the host
- **Resource limits**: CPU (NanoCPUs), memory, and PID limits enforced by Docker per agent configuration
- **Shell policy**: Command allowlist (optional) + deny pattern regex applied before execution; `subprocess.run(shell=False)` prevents shell injection
- **Filesystem policy**: Allowed path allowlist + denied path denylist with symlink resolution via `os.path.realpath()` — blocks path traversal attacks
- **Read-only config**: Agent config files mounted at `/etc/agentbox` as read-only
- **Container labels**: `managed-by=hill90-api` label verified before any container operation — prevents the API from accidentally managing unrelated containers
- **Docker socket proxy**: API service accesses Docker through a socket proxy that allows only container and volume operations (no image pulls, network changes, or builds)
- **Policy enforcement layer**: Shell and filesystem policies currently operate at the application layer via `app/shell.py` and `app/filesystem.py` modules. Container-level enforcement (seccomp, restricted PATH) is planned for Phase 3 of the runtime-first migration.

## Service-to-Service Authentication

Internal service endpoints use bearer tokens (shared secrets) distinct from agent JWTs:

| Token | Env Var | Used By | Authenticates To |
|-------|---------|---------|-----------------|
| AKM internal service token | `AKM_INTERNAL_SERVICE_TOKEN` | API service | Knowledge service `/internal/*` endpoints |
| Model-router internal service token | `MODEL_ROUTER_INTERNAL_SERVICE_TOKEN` | API service, AI service | AI service `/internal/*` endpoints |
| Delegation token signing | `MODEL_ROUTER_SIGNING_PRIVATE_KEY` | API service | Signs child delegation JWTs (private key never leaves API service) |

Both AKM and model-router signing private keys are held exclusively by the API service. The AI and Knowledge services only hold the corresponding public keys for JWT verification.

## Network Segmentation

- `hill90_edge`: ingress-facing network for Traefik and public app routes.
- `hill90_internal`: internal-only network for private service communication (API, AI, Knowledge, PostgreSQL, LiteLLM).
- `hill90_agent_internal`: elevated agent network — agents with `host_docker` or `vps_system` skill scopes are placed here. Reaches AI and Knowledge services but not edge, public internet, or Docker socket proxy.
- `hill90_agent_sandbox`: default agent network — agents with `container_local` or no skill scopes are placed here. Reaches AI and Knowledge services only.
- `hill90_docker_proxy`: isolated network for the Docker socket proxy. Only the API service connects — no agent containers can reach this network.
- Keycloak bridges both edge (public OIDC) and internal (database) networks.
- MinIO connects to both edge (Tailscale console) and internal (S3 API for app containers) networks.
- Tailscale-only routes are protected with Traefik middleware and IP allowlists.
- The AI service and Knowledge service both set `traefik.enable=false` — they are not publicly routed.

## TLS And Certificate Controls

- Public services use Let's Encrypt HTTP-01.
- Tailscale-only services use Let's Encrypt DNS-01 via `dns-manager` and Hostinger DNS API.
- ACME state is persisted in mounted Traefik storage for renewal continuity.

## Operational Hardening

- Host firewall allows 80/443 publicly and blocks public SSH.
- Deploy/rebuild actions run through scripted workflows (`make` + `scripts/*.sh`) to reduce manual drift.
- DNS and infrastructure reconciliation are automated during VPS rebuild/bootstrap.

## Verification Checklist

- `make health` passes after deploy.
- `ssh deploy@<public-ip>` fails while `ssh deploy@<tailscale-ip>` succeeds.
- `make dns-verify` confirms expected A/TXT propagation.
- Traefik logs show successful ACME issuance/renewal.
