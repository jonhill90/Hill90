# Secrets Schema Validation

The secrets schema validator ensures consistency between vault KV paths, SOPS keys, and Docker Compose `${VAR}` references. It catches drift before it reaches production.

## What It Checks

The validator (`scripts/checks/check_secrets_schema.py`) performs five validations:

| # | Check | Detects |
|---|-------|---------|
| 1 | Compose ref not in schema | A compose file uses `${FOO}` but FOO is not declared in the schema |
| 2 | SOPS key not in schema | A key exists in `prod.enc.env.example` but not in any schema category |
| 3 | Schema key not in SOPS | The schema declares a key but the SOPS example is missing it |
| 4 | Duplicate vault key without dedup | Same key in multiple vault paths without a `dedup` annotation |
| 5 | Compose refs mismatch | Schema says a key is in `docker-compose.api.yml` but it's actually not (or vice versa) |

## Schema File

The canonical schema is at `platform/vault/secrets-schema.yaml`. It defines:

- **excluded_vars**: Non-secret env vars (e.g., VERSION) that appear in compose as `${VAR}` but are not in vault or SOPS.
- **runtime_secrets**: Keys stored in vault with their KV path, compose file references, and optional dedup annotations.
- **bootstrap_secrets**: SOPS-only keys for infrastructure provisioning (no vault equivalent).
- **vault_management_secrets**: Keys generated during vault setup, stored in SOPS for DR.
- **vault_approle_services**: Service names that generate `VAULT_{SVC}_ROLE_ID` and `VAULT_{SVC}_SECRET_ID` pairs.

## Running Locally

```bash
# Advisory mode (default) — prints warnings, exits 0
python3 scripts/checks/check_secrets_schema.py

# Strict mode — exits 1 on any violation
SECRETS_SCHEMA_STRICT=1 python3 scripts/checks/check_secrets_schema.py

# Via make
make check-secrets-schema
```

## CI Integration

The check runs in `.github/workflows/ci.yml` on every PR:

```yaml
- name: Validate secrets schema consistency
  env:
    SECRETS_SCHEMA_STRICT: "0"
  run: python3 scripts/checks/check_secrets_schema.py
```

Currently runs in advisory mode (`STRICT=0`). After confirming no false positives across several PRs, flip to `STRICT=1` to make it blocking.

## Updating The Schema

When you add, remove, or move a secret:

1. **Add/update the vault KV path** via `vault.sh seed` or manual `bao kv put`.
2. **Update `platform/vault/secrets-schema.yaml`**:
   - Add the key under `runtime_secrets` with its `vault_path` and `compose_refs`.
   - If the key exists in multiple vault paths, add `dedup` to the canonical entry.
3. **Update `infra/secrets/prod.enc.env.example`** with the new key name.
4. **Run the validator** to confirm no drift:
   ```bash
   python3 scripts/checks/check_secrets_schema.py
   ```

### Adding a New Service AppRole

1. Add the service name to `vault_approle_services` in the schema.
2. Run `vault.sh setup` to create the AppRole in vault.
3. The validator will expect `VAULT_{SVC}_ROLE_ID` and `VAULT_{SVC}_SECRET_ID` in the SOPS example.

### Adding a Bootstrap Secret

Add the key name to `bootstrap_secrets` in the schema. Bootstrap secrets have no vault mapping.

### Adding a Vault Management Secret

Add the key name to `vault_management_secrets`. These are generated during vault setup and stored in SOPS for DR.

## Tests

The validator has a pytest suite at `tests/checks/test_secrets_schema.py`:

```bash
pytest tests/checks/test_secrets_schema.py -v
```

Tests cover: schema loading, current-state validation, missing compose refs, unknown SOPS keys, duplicate key warnings, strict/advisory exit codes.

## See Also

- [Secrets Architecture](../architecture/secrets-model.md) — vault architecture and KV path map
- [Secrets Workflow Guide](./secrets-workflow.md) — day-to-day secrets operations
