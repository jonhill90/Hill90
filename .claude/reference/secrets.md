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

## Best Practices

**RECOMMENDED approaches:**
- ✅ `make secrets-view KEY=<key>` - Safe viewing
- ✅ `make secrets-update KEY=<key> VALUE=<value>` - Safe updates with auto-backup
- ✅ `make secrets-edit` - Interactive editing
- ✅ `bash scripts/secrets-*.sh` - Helper scripts with safety checks

**AVOID:**
- ❌ Direct `sops -d` to temp files (leaves unencrypted secrets on disk)
- ❌ Manual decrypt → edit → encrypt cycles (corruption risk)
- ❌ Using `sed` or other text tools on encrypted files

**If something goes wrong:**
```bash
git checkout HEAD -- infra/secrets/prod.enc.env    # Restore from git
# Or restore from backup created by secrets-update.sh
```
