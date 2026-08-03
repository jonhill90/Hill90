# Secrets Architecture

> **Status as of 2026-07-26: the vault is running. SOPS is still the path
> deploys use.**
>
> Both statements are true and the distinction matters.
>
> OpenBao was reinitialized on 2026-07-26 (JON-45) after being absent since the
> June 14 rebuild. It is up, healthy, initialized and unsealed, auto-unseal is
> proven to survive a container restart — including through
> `hill90-vault-unseal.service`, which is what runs at boot — and
> `deploy-vault.yml` is green.
>
> **But the vault holds nothing.** `vault.sh setup` and `vault.sh seed` have
> not been run, so there are no policies, no AppRoles and no KV data. Every
> deploy therefore still reads its secrets from SOPS. That is not a guess; the
> green vault deploy logged it:
>
> ```
> WARNING: OpenBao available but login failed for vault, falling back to SOPS
> ```
>
> So: vault is **available** infrastructure, SOPS is the **operative** store.
> Nothing reads a secret out of the vault today.
>
> Filling it is a deliberate next step, not an oversight — it depends on the
> open question in [Vault vs SOPS](../decisions/vault-vs-sops.md), which is
> still Jon's call. Running `setup` and `seed` also needs a root token, and the
> one minted at init was revoked immediately by design; a new one comes from the
> unseal key via `bash scripts/vault.sh regain-root`, which needs the vault
> redeployed on `config.recovery.hcl` first — `gh workflow run
> vault-regain-root.yml` does both. **Not** `bao operator generate-root`: that CLI
> targets a legacy path and returns 403 whatever the configuration.

## Intended model

OpenBao is the runtime source of truth for secrets. SOPS is the bootstrap and disaster-recovery backup. Deploy is vault-first with SOPS fallback.

## Architecture Overview

```text
┌─────────────────────────────────────────────────────┐
│                   Vault (OpenBao)                    │
│                                                     │
│  secret/infra/traefik                               │
│  secret/observability/grafana                       │
│                                                     │
│  auth/approle/role/{svc}  (per-service AppRoles)    │
│  auth/token/              (admin access)            │
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
| `secret/infra/traefik` | TRAEFIK_ADMIN_PASSWORD_HASH, ACME_EMAIL, ACME_CA_SERVER, CF_DNS_API_TOKEN | traefik |
| `secret/infra/vps` | HOSTINGER_API_KEY | VPS management (not DNS) |
| `secret/observability/grafana` | GRAFANA_ADMIN_PASSWORD | grafana |

`platform/vault/secrets-schema.yaml` is the canonical mapping of vault paths to
SOPS keys to compose `${VAR}` references, and `scripts/checks/check_secrets_schema.py`
enforces it on every pull request.

## AppRole Authentication

Each service gets its own AppRole with a scoped policy:

```text
vault.sh setup → creates AppRole per service
                → generates VAULT_{SVC}_ROLE_ID + VAULT_{SVC}_SECRET_ID
                → stores credentials in SOPS for deploy-time injection
```

Services: infra, observability.

At deploy time, `deploy.sh` injects the AppRole credentials as environment variables. The container authenticates to vault on startup and reads its scoped secrets.

## Admin Access — Token Only

Vault UI and CLI access is by **OIDC single sign-on or token**. `Verified 2026-08-03`
by a completed authorization-code login: `jon` authenticates through Keycloak realm
`platform` and receives `policy-oidc-admin`. Reproduce with
`bash scripts/checks/vault-oidc-login-test.sh`.

**This section said the opposite and must not be followed.** It read "There is no
SSO", explained that OIDC "was removed when the Keycloak stack was retired
alongside the shelved application", and instructed the reader: *"do not re-add
`vault.sh setup-oidc` without first re-introducing an identity provider."* That was
true in June 2026. Keycloak returned as a **platform** service in July, the
identity provider that instruction asked for exists, and `setup-oidc` has since
been run — so the instruction now forbids work that is already done and working.

Token access remains, and is the break-glass path when OIDC or Keycloak is
unavailable.

To obtain a token:

- The initial root token is emitted by `vault.sh init` and stored in SOPS.
- For one-off admin work, generate a fresh root token with
  `bao operator generate-root` and **revoke it immediately afterwards**.
- Services authenticate by AppRole, never by root token.

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
| Vault management | OPENBAO_UNSEAL_KEY, VAULT_SYNC_TOKEN | Generated during vault setup, stored for DR |
| AppRole credentials | VAULT_{SVC}_ROLE_ID, VAULT_{SVC}_SECRET_ID | Per-service vault authentication |

## See Also

- [Secrets Workflow Guide](../runbooks/secrets-workflow.md) — day-to-day secrets operations
- [Vault Unseal Runbook](../runbooks/vault-unseal.md) — auto-unseal operations
- [Secrets Schema Validation](../runbooks/secrets-schema-validation.md) — schema validation reference
- [Security Architecture](./security.md) — broader security posture
