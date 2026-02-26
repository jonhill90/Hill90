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

For each service, generate new AppRole credentials and store them in SOPS:

```bash
# Example for api:
bao read auth/approle/role/api/role-id
bao write -f auth/approle/role/api/secret-id
```

Update SOPS with each service's role_id and secret_id:

```bash
make secrets-update KEY=VAULT_API_ROLE_ID VALUE="<role-id>"
make secrets-update KEY=VAULT_API_SECRET_ID VALUE="<secret-id>"
```

Repeat for: `db`, `api`, `ai`, `auth`, `ui`, `mcp`, `minio`, `infra`, `observability`.

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

- Vault requires manual unseal after every container restart. This is by design (no auto-unseal).
- SOPS is the bootstrap mechanism. All runtime secrets must be present in SOPS to seed vault on a fresh install.
- After recovery, run `vault.sh sync-to-sops` periodically to keep the SOPS backup current.
- DNS records may need updating if the VPS IP changed: `bash scripts/hostinger.sh dns sync`.
