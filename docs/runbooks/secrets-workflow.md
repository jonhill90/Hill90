# Secrets Workflow Guide

Vault-first secrets management for the Hill90 platform.

## Architecture

- **Vault (OpenBao)**: Authoritative source for all runtime secrets. Services read secrets from vault at deploy time via AppRole authentication.
- **SOPS**: Bootstrap mechanism and disaster recovery backup. Used to seed vault on fresh installs and as fallback when vault is unavailable.

## Secret Categories

| Category | Managed In | Examples |
|----------|-----------|----------|
| Runtime secrets | Vault (primary), SOPS (backup) | DB_PASSWORD, JWT_SECRET, API keys |
| Bootstrap secrets | SOPS only | VPS_IP, TAILSCALE_IP, TAILSCALE_AUTH_KEY |
| Vault credentials | SOPS only | OPENBAO_UNSEAL_KEY, VAULT_*_ROLE_ID, VAULT_*_SECRET_ID |

## Day-to-Day Workflows

### Adding a New Runtime Secret

1. Add the secret to the appropriate vault KV path:
   ```bash
   export BAO_TOKEN="<admin-token>"
   docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$BAO_TOKEN" openbao \
       bao kv patch secret/<service>/config NEW_KEY="new-value"
   ```

2. Sync vault to SOPS so the backup stays current:
   ```bash
   bash scripts/vault.sh sync-to-sops
   ```

3. Update `cmd_seed()` in `scripts/vault.sh` to include the new key (so future seeds work).

4. Update the service's vault policy if a new path is needed.

### Rotating a Runtime Secret

1. Update the secret in vault:
   ```bash
   export BAO_TOKEN="<admin-token>"
   docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$BAO_TOKEN" openbao \
       bao kv patch secret/<service>/config ROTATED_KEY="new-value"
   ```

2. Redeploy the affected service to pick up the new value:
   ```bash
   bash scripts/deploy.sh <service> prod
   ```

3. Sync to SOPS:
   ```bash
   bash scripts/vault.sh sync-to-sops
   ```

### Adding a Bootstrap Secret

Bootstrap secrets (VPS_IP, Tailscale keys, etc.) are only in SOPS — vault does not manage them.

```bash
make secrets-update KEY=NEW_BOOTSTRAP_KEY VALUE="value"
```

### Viewing Current Secrets

From vault (runtime secrets):
```bash
export BAO_TOKEN="<admin-token>"
bash scripts/vault.sh export
```

From SOPS (all secrets including bootstrap):
```bash
make secrets-view
make secrets-view KEY=SPECIFIC_KEY
```

## Sync Commands

| Direction | Command | When to Use |
|-----------|---------|-------------|
| SOPS -> Vault | `bash scripts/vault.sh seed` | Fresh install, disaster recovery |
| Vault -> SOPS | `bash scripts/vault.sh sync-to-sops` | After vault changes, periodic backup |

## Vault KV Path Map

| Path | Keys | Canonical For |
|------|------|--------------|
| `secret/api/config` | INTERNAL_SERVICE_SECRET, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD | API service + shared MinIO/internal creds |
| `secret/shared/database` | DB_USER, DB_PASSWORD, DB_NAME | All services needing DB access |
| `secret/shared/jwt` | JWT_SECRET, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY | All services needing JWT |
| `secret/ai/config` | ANTHROPIC_API_KEY, OPENAI_API_KEY | AI service |
| `secret/auth/config` | KC_ADMIN_USERNAME, KC_ADMIN_PASSWORD, SMTP_PASSWORD | Auth (Keycloak) service |
| `secret/ui/config` | AUTH_KEYCLOAK_ID, AUTH_KEYCLOAK_SECRET, AUTH_SECRET | UI service |
| `secret/minio/config` | MINIO_ROOT_USER, MINIO_ROOT_PASSWORD | MinIO (duplicates from api/config) |
| `secret/infra/traefik` | TRAEFIK_ADMIN_PASSWORD_HASH, ACME_EMAIL, ACME_CA_SERVER | Traefik reverse proxy |
| `secret/infra/dns-manager` | HOSTINGER_API_KEY | DNS manager |
| `secret/observability/grafana` | GRAFANA_ADMIN_PASSWORD | Grafana |
| `secret/mcp/config` | INTERNAL_SERVICE_SECRET | MCP service (duplicate from api/config) |

## Periodic Maintenance

- **After any vault change**: Run `vault.sh sync-to-sops` to keep the SOPS backup current.
- **Weekly (recommended)**: Run `vault.sh sync-to-sops` as a routine backup sync.
- **Before VPS rebuild**: Ensure SOPS is up to date — it's the only way to reseed vault on a fresh install.

## Deduplication

Some keys exist in multiple vault paths (e.g., MINIO_ROOT_USER in both `api/config` and `minio/config`). The `sync-to-sops` command reads `api/config` first and skips duplicates from later paths, so SOPS always gets the canonical value.
