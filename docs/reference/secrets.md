# Secrets Management Reference

> **Architecture:** OpenBao vault is the runtime source of truth for secrets. SOPS + age serves as bootstrap and disaster-recovery backup. Deploy is vault-first with SOPS fallback. See [Secrets Architecture](../../docs/architecture/secrets-model.md) and [Secrets Workflow](../../docs/runbooks/secrets-workflow.md) for full details.

## Age Key Locations

- **Local (project):** `infra/secrets/keys/age-prod.key` — **gitignored, never committed** (`.gitignore` excludes `infra/secrets/keys/*.key` and `*.key`). Only the public `age-prod.pub` is tracked. Restore it from your password manager or the VPS.
- **VPS:** `/opt/hill90/secrets/keys/keys.txt`
- **Symlinked on VPS:** `/opt/hill90/app/infra/secrets/keys/age-prod.key` → `/opt/hill90/secrets/keys/keys.txt`

**Note:** Scripts automatically use the project-local key. No manual configuration needed.

## Viewing Secrets (RECOMMENDED - Safe, no temp files)

**Using Makefile commands (easiest):**
```bash
make secrets-view                    # View all secrets
make secrets-view KEY=VPS_IP         # View specific secret
```

**Using scripts directly:**
```bash
bash scripts/secrets.sh view infra/secrets/prod.enc.env              # All secrets
bash scripts/secrets.sh view infra/secrets/prod.enc.env VPS_IP       # Specific secret
```

## Updating Secrets (RECOMMENDED - Safe, automatic backup)

**Using Makefile commands (easiest):**
```bash
make secrets-update KEY=VPS_IP VALUE="76.13.26.69"
# Creates automatic backup before update
# Restores from backup if update fails
```

**Using scripts directly:**
```bash
bash scripts/secrets.sh update infra/secrets/prod.enc.env VPS_IP "76.13.26.69"
```

## Editing Secrets Interactively

**Using Makefile (easiest):**
```bash
make secrets-edit    # Opens in your default editor
```

**Using SOPS directly:**
```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key
sops infra/secrets/prod.enc.env
# SOPS will decrypt, open in editor, and re-encrypt automatically
```

## Advanced: Programmatic Updates (for scripts)

```bash
export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key

# Update single value atomically (NO temp files!)
sops --set '["VPS_IP"] "76.13.26.69"' infra/secrets/prod.enc.env

# Execute command with decrypted environment (NO temp files!)
sops exec-env infra/secrets/prod.enc.env 'echo $VPS_IP'

# Extract specific value
sops -d --extract '["VPS_IP"]' infra/secrets/prod.enc.env
```

## Important Secrets

### TRAEFIK_ADMIN_PASSWORD_HASH

Bcrypt password hash for Traefik dashboard authentication.

**Usage:**
- Deployed to: `platform/edge/dynamic/.htpasswd`
- Format: `$2y$05$...` (bcrypt hash)
- Username: `admin`
- Generated during: Every deployment via deploy scripts

**To update the password:**

```bash
# 1. Generate new password
NEW_PASSWORD=$(openssl rand -base64 20 | tr -d '/+=' | cut -c1-20)
echo "New password: $NEW_PASSWORD"  # Save this in password manager!

# 2. Generate bcrypt hash
NEW_HASH=$(htpasswd -nbB admin "$NEW_PASSWORD" | cut -d: -f2)

# 3. Update secret (use sops directly to preserve $ symbols)
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  sops --set '["TRAEFIK_ADMIN_PASSWORD_HASH"] "'"$NEW_HASH"'"' infra/secrets/prod.enc.env

# 4. Commit and deploy
git add infra/secrets/prod.enc.env
git commit -m "Update Traefik password"
git push
```

**Security note:** The plaintext password is NEVER stored in the repo or secrets - only the bcrypt hash is stored.

### VPS_IP

Public IP address of the VPS (automatically updated by `make recreate-vps`).

### TAILSCALE_IP

Tailscale VPN IP address (automatically updated by Ansible during `make config-vps`).

### TAILSCALE_AUTH_KEY

Ephemeral auth key for Tailscale (90-day expiry, automatically generated during VPS recreate).

### HOSTINGER_API_KEY

API key for Hostinger VPS management, used by `scripts/vps.sh` and the
`recreate-vps` workflow. No longer part of any certificate or DNS-01 path.

### CF_DNS_API_TOKEN

Cloudflare API token used by Traefik/lego for the ACME DNS-01 challenge. Scoped
to the `hill90.com` zone with Zone/Zone/Read and Zone/DNS/Edit. Not a Global API Key.

### The tenant's OIDC client secret — why `AUTH_KEYCLOAK_SECRET` is not here

**If you are looking for a Keycloak client secret in this store and cannot find
one, that is the correct outcome. Do not add one.**

Two different names describe the same credential — the secret for client
`hill90-ui` in realm `platform` — and only one of them belongs in this
repository:

| Name | Whose | Where it lives |
|---|---|---|
| `HILL90_UI_CLIENT_SECRET` | the platform's | this store, declared in `platform/vault/secrets-schema.yaml` |
| `AUTH_KEYCLOAK_SECRET` | the **tenant's** | hill90-app's store, never this one |

`AUTH_KEYCLOAK_SECRET` is the name hill90-app uses for its copy, because that is
what NextAuth expects. A value under that name in *this* store opens nothing: the
platform reads `HILL90_UI_CLIENT_SECRET`, and nothing here consumes the other
name. One did exist and was removed in #596 — it was 32 characters against a live
64-character secret, so anyone who found it and used it would have got
`unauthorized_client` with nothing explaining why.

**`HILL90_UI_CLIENT_SECRET` itself is declared but currently has no production
value**, which is deliberate rather than an oversight. `scripts/keycloak.sh
tenant-clients` never rewrites an existing client's secret, so production is
unaffected — the live client already exists and its secret is correct. The case
that depends on this key is a **VPS rebuild**, where the realm is imported for the
first time, and then it must equal the value hill90-app holds.
`check_env_surface.py` deliberately allows it no default: a fallback would import
a *known* secret for the client fronting hill90.com and say nothing.

Ownership is argued in
[tenant-credential-ownership.md](../decisions/tenant-credential-ownership.md):
the object lives in the platform's realm, so the platform is authoritative and the
tenant holds the replica — not the other way around.

## Best Practices

**RECOMMENDED approaches:**
- ✅ `make secrets-view KEY=<key>` - Safe viewing
- ✅ `make secrets-update KEY=<key> VALUE=<value>` - Safe updates with auto-backup
- ✅ `make secrets-edit` - Interactive editing
- ✅ `bash scripts/secrets.sh <command>` - Helper scripts with safety checks
- ✅ `sops --set` for values with special characters (like password hashes with $)

**AVOID:**
- ❌ Direct `sops -d` to temp files (leaves unencrypted secrets on disk)
- ❌ Manual decrypt → edit → encrypt cycles (corruption risk)
- ❌ Using `sed` or other text tools on encrypted files
- ❌ `make secrets-update` for values with $ symbols (shell escaping issues)

**If something goes wrong:**
```bash
git checkout HEAD -- infra/secrets/prod.enc.env    # Restore from git
# Or restore from backup created by secrets.sh update
```
