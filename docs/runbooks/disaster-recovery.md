# Disaster Recovery Runbook

Full platform recovery procedure from total VPS/infrastructure loss.

## Prerequisites

Before starting recovery, ensure you have:

- [ ] Local clone of the Hill90 git repository (up to date with `main`)
- [ ] SOPS encrypted secrets file: `infra/secrets/prod.enc.env`
- [ ] Age private key: `infra/secrets/keys/age-prod.key`
- [ ] Hostinger API access (for VPS creation)
- [ ] Tailscale account access (for network re-join)

## Recovery Steps

### 1. Recreate VPS

Provision a fresh VPS via the Hostinger API.

```bash
bash scripts/vps.sh recreate
```

This creates a new VPS, installs the base OS, and returns the new public IP. See `docs/runbooks/vps-rebuild.md` for detailed steps.

### 2. Configure VPS

Bootstrap the VPS with Docker, SOPS, age, and Tailscale.

```bash
bash scripts/vps.sh config <NEW_VPS_IP>
```

Update `VPS_IP` and `TAILSCALE_IP` in SOPS if they changed:

```bash
make secrets-update KEY=VPS_IP VALUE="<new-ip>"
make secrets-update KEY=TAILSCALE_IP VALUE="<new-tailscale-ip>"
```

### 3. Deploy Infrastructure

Deploy Traefik (reverse proxy), dns-manager, and Portainer.

```bash
bash scripts/deploy.sh infra prod
```

### 4. Deploy and Initialize Vault

Deploy the OpenBao container:

```bash
bash scripts/deploy.sh vault prod
```

Initialize vault (generates new unseal key and root token):

```bash
bash scripts/vault.sh init
```

Save the unseal key and root token as instructed by the output.

Store the unseal key on the host:

```bash
# On VPS:
echo "<unseal-key>" | sudo tee /opt/hill90/secrets/openbao-unseal.key
sudo chown deploy:deploy /opt/hill90/secrets/openbao-unseal.key
sudo chmod 0600 /opt/hill90/secrets/openbao-unseal.key
```

Update SOPS with the new unseal key:

```bash
make secrets-update KEY=OPENBAO_UNSEAL_KEY VALUE="<unseal-key>"
```

### 5. Unseal Vault

```bash
bash scripts/vault.sh unseal
```

### 6. Setup Vault

Enable KV v2, AppRole auth, audit logging, apply policies, and create service roles.

```bash
export BAO_TOKEN="<root-token>"
bash scripts/vault.sh setup
```

### 7. Seed Vault from SOPS

Push all secrets from the SOPS backup into vault KV v2 paths.

```bash
bash scripts/vault.sh seed
```

### 8. Generate and Store AppRole Credentials

Bootstrap all AppRole credentials automatically:

```bash
bash scripts/vault.sh bootstrap-approles
```

This generates role_id + secret_id for all 9 services and stores them in SOPS. It temporarily generates a root token (via unseal key), runs setup, creates credentials, then revokes the root token.

### 9. Deploy Database

```bash
bash scripts/deploy.sh db prod
```

Restore database from backup if available:

```bash
bash scripts/backup.sh restore db /path/to/backup
```

### 10. Deploy All Services

```bash
bash scripts/deploy.sh all prod
```

### 11. Verify Health

```bash
bash scripts/ops.sh health
```

Check each service endpoint responds correctly.

### 12. Revoke Root Token

```bash
docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="<root-token>" openbao bao token revoke -self
```

### 13. Post-Recovery: Sync Vault to SOPS

Confirm the SOPS backup reflects the current vault state:

```bash
export BAO_TOKEN="<admin-token>"
bash scripts/vault.sh sync-to-sops
```

## Recovery Order Summary

```
VPS recreate -> VPS config -> infra -> vault (deploy+init+unseal+setup+seed)
  -> AppRole creds -> db (+ restore) -> all services -> health check
  -> revoke root token -> sync vault to SOPS
```

## Notes

- Vault auto-unseals after deploy (`deploy.sh vault` calls `vault.sh auto-unseal`) and on VPS boot (systemd `hill90-vault-unseal` service). Manual unseal is available as fallback: `bash scripts/vault.sh unseal`.
- SOPS is the bootstrap mechanism. All runtime secrets must be present in SOPS to seed vault on a fresh install.
- `SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt` must be set in the deploy user's environment for SOPS fallback to work. The Ansible bootstrap (playbook 12) configures this automatically.
- After recovery, run `vault.sh sync-to-sops` periodically to keep the SOPS backup current.
- DNS records may need updating if the VPS IP changed: `bash scripts/hostinger.sh dns sync`.
