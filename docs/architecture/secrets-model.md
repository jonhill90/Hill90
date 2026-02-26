# Secrets Architecture

OpenBao is the runtime source of truth for secrets. SOPS is the bootstrap and disaster-recovery backup. Deploy is vault-first with SOPS fallback.

## Architecture Overview

```text
┌─────────────────────────────────────────────────────┐
│                   Vault (OpenBao)                    │
│                                                     │
│  secret/shared/database   secret/api/config         │
│  secret/shared/jwt        secret/ai/config          │
│  secret/auth/config       secret/ui/config          │
│  secret/minio/config      secret/infra/traefik      │
│  secret/infra/dns-manager secret/observability/...   │
│                                                     │
│  auth/approle/role/{svc}  (per-service AppRoles)    │
│  auth/oidc/               (admin SSO via Keycloak)  │
└───────┬─────────────────────────┬───────────────────┘
        │ AppRole login           │ sync-to-sops
        ▼                         ▼
  ┌───────────┐           ┌───────────────┐
  │  deploy.sh │           │ SOPS backup   │
  │  (runtime) │           │ (DR/bootstrap)│
  └─────┬─────┘           └───────────────┘
        │ env injection
        ▼
  ┌─────────────┐
  │  Containers  │
  └─────────────┘
```

## Vault KV Path Map

All secrets are stored in vault KV v2 under `secret/`.

| Path | Keys | Consumers |
|------|------|-----------|
| `secret/shared/database` | DB_USER, DB_PASSWORD, DB_NAME | db, auth, api |
| `secret/shared/jwt` | JWT_SECRET, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY | api, ai, mcp |
| `secret/api/config` | INTERNAL_SERVICE_SECRET, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD | api |
| `secret/ai/config` | ANTHROPIC_API_KEY, OPENAI_API_KEY | ai |
| `secret/auth/config` | KC_ADMIN_USERNAME, KC_ADMIN_PASSWORD, SMTP_PASSWORD | auth (Keycloak) |
| `secret/ui/config` | AUTH_KEYCLOAK_ID, AUTH_KEYCLOAK_SECRET, AUTH_SECRET | ui |
| `secret/minio/config` | MINIO_ROOT_USER, MINIO_ROOT_PASSWORD | minio |
| `secret/infra/traefik` | TRAEFIK_ADMIN_PASSWORD_HASH, ACME_EMAIL, ACME_CA_SERVER | traefik |
| `secret/infra/dns-manager` | HOSTINGER_API_KEY | dns-manager |
| `secret/observability/grafana` | GRAFANA_ADMIN_PASSWORD | grafana |

Some keys exist in multiple vault paths (e.g., MINIO_ROOT_USER in both `secret/api/config` and `secret/minio/config`). The schema YAML tracks these as `dedup` annotations to prevent false-positive warnings.

## AppRole Authentication

Each service gets its own AppRole with a scoped policy:

```text
vault.sh setup → creates AppRole per service
                → generates VAULT_{SVC}_ROLE_ID + VAULT_{SVC}_SECRET_ID
                → stores credentials in SOPS for deploy-time injection
```

Services: db, api, ai, auth, ui, mcp, minio, infra, observability.

At deploy time, `deploy.sh` injects the AppRole credentials as environment variables. The container authenticates to vault on startup and reads its scoped secrets.

## OIDC SSO (Admin Access)

Human operators access vault via OIDC through Keycloak:

- Keycloak client: `hill90-vault`
- Vault role: `admin-sso`
- Policy: `policy-oidc-admin`
- Setup: `vault.sh setup-oidc`

## Auto-Unseal

Vault starts sealed after every container restart. Three mechanisms handle unsealing:

1. **Deploy-time**: `deploy.sh vault` calls `vault.sh auto-unseal` after compose up.
2. **Boot-time**: `hill90-vault-unseal` systemd service runs `vault.sh auto-unseal` after docker.service starts.
3. **Manual fallback**: `vault.sh unseal` for ad-hoc recovery.

The unseal key is stored at `/opt/hill90/secrets/openbao-unseal.key` on the VPS (permissions 0600, owner deploy:deploy).

See [Vault Unseal Runbook](../runbooks/vault-unseal.md) for operational details.

## Sync to SOPS

Vault secrets are periodically synced back to SOPS as a DR backup:

- **Automated**: `vault-sync-to-sops` GitHub Actions workflow (weekly schedule + manual trigger).
- **Manual**: `vault.sh sync-to-sops` exports vault KV to the SOPS-encrypted file.
- **Token**: A dedicated `vault-sync` policy and periodic token, stored in SOPS as `VAULT_SYNC_TOKEN`.

## Schema Validation

The canonical mapping between vault KV paths, SOPS keys, and compose `${VAR}` references is defined in `platform/vault/secrets-schema.yaml`.

CI runs `scripts/checks/check_secrets_schema.py` on every PR to detect drift:
- Compose file references a `${VAR}` not in the schema.
- SOPS example has a key not declared in any schema category.
- Schema declares a key missing from the SOPS example.
- Duplicate vault keys without a `dedup` annotation.
- Schema `compose_refs` don't match actual compose file references.

See [Secrets Schema Validation](../runbooks/secrets-schema-validation.md) for details.

## SOPS Categories

Not all secrets live in vault. SOPS holds three additional categories:

| Category | Keys | Purpose |
|----------|------|---------|
| Bootstrap | VPS_HOST, VPS_IP, TAILSCALE_AUTH_KEY, GHCR_TOKEN | Infrastructure provisioning (no vault equivalent) |
| Vault management | OPENBAO_UNSEAL_KEY, VAULT_OIDC_CLIENT_SECRET, VAULT_SYNC_TOKEN | Generated during vault setup, stored for DR |
| AppRole credentials | VAULT_{SVC}_ROLE_ID, VAULT_{SVC}_SECRET_ID | Per-service vault authentication |

## See Also

- [Secrets Workflow Guide](../runbooks/secrets-workflow.md) — day-to-day secrets operations
- [Vault Unseal Runbook](../runbooks/vault-unseal.md) — auto-unseal operations
- [Secrets Schema Validation](../runbooks/secrets-schema-validation.md) — schema validation reference
- [Security Architecture](./security.md) — broader security posture
