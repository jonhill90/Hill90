# Secrets Management Reference

## Age Key Locations

- **Local (project):** `infra/secrets/keys/age-prod.key` (tracked in repo, used by scripts)
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
bash scripts/secrets-view.sh infra/secrets/prod.enc.env              # All secrets
bash scripts/secrets-view.sh infra/secrets/prod.enc.env VPS_IP       # Specific secret
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
bash scripts/secrets-update.sh infra/secrets/prod.enc.env VPS_IP "76.13.26.69"
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
- Deployed to: `deployments/platform/edge/dynamic/.htpasswd`
- Format: `$2y$05$...` (bcrypt hash)
- Username: `admin`
- Generated during: Every deployment via `scripts/deploy.sh`

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

API key for Hostinger DNS and VPS management.

## Best Practices

**RECOMMENDED approaches:**
- ✅ `make secrets-view KEY=<key>` - Safe viewing
- ✅ `make secrets-update KEY=<key> VALUE=<value>` - Safe updates with auto-backup
- ✅ `make secrets-edit` - Interactive editing
- ✅ `bash scripts/secrets-*.sh` - Helper scripts with safety checks
- ✅ `sops --set` for values with special characters (like password hashes with $)

**AVOID:**
- ❌ Direct `sops -d` to temp files (leaves unencrypted secrets on disk)
- ❌ Manual decrypt → edit → encrypt cycles (corruption risk)
- ❌ Using `sed` or other text tools on encrypted files
- ❌ `make secrets-update` for values with $ symbols (shell escaping issues)

**If something goes wrong:**
```bash
git checkout HEAD -- infra/secrets/prod.enc.env    # Restore from git
# Or restore from backup created by secrets-update.sh
```
