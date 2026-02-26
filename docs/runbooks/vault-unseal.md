# Vault Unseal Runbook

OpenBao (vault) starts sealed after every container restart. This runbook covers the auto-unseal mechanisms and manual fallback.

## How Auto-Unseal Works

The `vault.sh auto-unseal` command:

1. Waits up to 120 seconds for the `openbao` container to be running.
2. Waits up to 30 seconds for the vault API to respond.
3. Validates unseal key file permissions (expects 0600, owner deploy).
4. Reads the unseal key from `/opt/hill90/secrets/openbao-unseal.key`.
5. Sends the unseal request to vault.

If the container doesn't exist (e.g., fresh VPS before vault is deployed), the command exits 0 gracefully — it does not fail.

## Unseal Mechanisms

### 1. Deploy-Time (Automatic)

When you run `deploy.sh vault prod`, the script automatically calls `vault.sh auto-unseal` after bringing the container up. If auto-unseal fails, a warning is printed but the deploy continues.

```bash
bash scripts/deploy.sh vault prod
# → compose up → auto-unseal → verify
```

### 2. Boot-Time (Systemd Service)

The `hill90-vault-unseal` systemd service runs after docker.service starts on VPS boot:

```ini
[Unit]
Description=Hill90 OpenBao Auto-Unseal
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=deploy
ExecStart=/opt/hill90/app/scripts/vault.sh auto-unseal
Environment=SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt
TimeoutStartSec=180
RemainAfterExit=yes
```

Check service status:
```bash
systemctl status hill90-vault-unseal
journalctl -u hill90-vault-unseal --no-pager -n 50
```

### 3. Manual Fallback

If auto-unseal fails, unseal manually:

```bash
# On VPS:
bash scripts/vault.sh unseal

# Or via SSH:
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && bash scripts/vault.sh unseal'
```

## Unseal Key Location

| Location | Path | Purpose |
|----------|------|---------|
| VPS host | `/opt/hill90/secrets/openbao-unseal.key` | Runtime unseal |
| SOPS backup | `OPENBAO_UNSEAL_KEY` in `infra/secrets/prod.enc.env` | Disaster recovery |

Requirements:
- File permissions: `0600`
- Owner: `deploy:deploy`
- Must not be owned by root (deploy scripts run as the deploy user without sudo)

## Troubleshooting

### Vault Sealed After Reboot

1. Check if the systemd service ran:
   ```bash
   journalctl -u hill90-vault-unseal --no-pager -n 20
   ```

2. If the service didn't trigger, check that it's enabled:
   ```bash
   systemctl is-enabled hill90-vault-unseal
   ```

3. If enabled but failed, check the unseal key:
   ```bash
   ls -la /opt/hill90/secrets/openbao-unseal.key
   # Should show: -rw------- deploy deploy
   ```

4. Manual unseal:
   ```bash
   bash scripts/vault.sh unseal
   ```

### Deploy Verify Fails (Sealed)

This means auto-unseal didn't complete before verify ran. Check:

```bash
bash scripts/vault.sh status
# If sealed:
bash scripts/vault.sh unseal
bash scripts/deploy.sh verify vault prod
```

### Auto-Unseal Timeout

The default timeout is 120 seconds (`VAULT_AUTO_UNSEAL_TIMEOUT`). If the container takes longer to start:

```bash
VAULT_AUTO_UNSEAL_TIMEOUT=300 bash scripts/vault.sh auto-unseal
```

### Wrong Unseal Key Permissions

```bash
# Fix permissions:
chmod 600 /opt/hill90/secrets/openbao-unseal.key
chown deploy:deploy /opt/hill90/secrets/openbao-unseal.key
```

### Docker Healthcheck Shows Unhealthy

The vault healthcheck reports unhealthy when sealed (HTTP 503). This is correct behavior — vault is running but cannot serve requests until unsealed. After unsealing, the healthcheck will transition to healthy.

```bash
# Check current health:
docker inspect --format='{{.State.Health.Status}}' openbao

# Unseal, then verify:
bash scripts/vault.sh unseal
sleep 5
docker inspect --format='{{.State.Health.Status}}' openbao
# Should show: healthy
```

## Ansible Installation

The systemd service is installed by Ansible playbook `infra/ansible/playbooks/11-vault-unseal.yml`, which runs during VPS bootstrap. To re-install manually:

```bash
sudo cp /opt/hill90/app/infra/systemd/hill90-vault-unseal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hill90-vault-unseal
```

## See Also

- [Secrets Architecture](../architecture/secrets-model.md) — vault architecture overview
- [Deployment Runbook](./deployment.md) — full deployment procedures
- [Troubleshooting Guide](./troubleshooting.md) — general troubleshooting
