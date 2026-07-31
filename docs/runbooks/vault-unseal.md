# Vault Unseal Runbook

OpenBao (vault) starts sealed after every container restart. This runbook covers the auto-unseal mechanisms and manual fallback.

> **Do not revoke the root token before the vault is configured (2026-07-26).**
> On OpenBao >= 2.5.3 the unauthenticated root-generation endpoints are disabled
> by default, so `bao operator generate-root` returns **403** — verified against
> 2.6.1, both before and after revocation, with the flag set at listener and at
> top level. With no other sudo-capable token, there is then no supported way
> back to root, and the vault cannot be configured at all.
>
> Correct order: `init` -> `unseal` -> `setup` -> `seed` -> `setup-sync-token`
> -> `revoke-root`. The `vault-init` workflow now leaves the root token in place
> by default (`revoke_root: false`) for exactly this reason.
>
> This is what happened on 2026-07-26: root was revoked immediately after init,
> which left a healthy but permanently unconfigurable vault. Recovering means
> reinitializing.


> **Fresh initialization (2026-07-26).** `vault.sh init` no longer prints the
> unseal key or root token. It writes both to `0600` files owned by whoever
> runs it — on the host that is `deploy`, which is what the auto-unseal systemd
> unit runs as. The previous instructions said to `sudo tee` the unseal key,
> which produced a **root-owned** file the unit could not read, so auto-unseal
> would have failed on the first reboot. Do not reintroduce `sudo` there.
>
> After `setup` and `seed`, run `bash scripts/vault.sh revoke-root`. It revokes
> the root token, verifies independently that it is dead (`bao token revoke
> -self` reports success even for a token that never existed), and removes the
> file.
>
> The unseal key must also reach SOPS as `OPENBAO_UNSEAL_KEY`. The host
> checkout is `git reset --hard` on every deploy, so a SOPS edit made on the
> host is discarded — it has to be committed from a workstation.


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

## SOPS Fallback Requirement

When vault is unavailable, deploy scripts fall back to SOPS for secrets. This requires the `SOPS_AGE_KEY_FILE` environment variable:

```
SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt
```

The Ansible bootstrap (playbook `12-deploy-profile.yml`) adds this to the deploy user's `.bashrc` automatically. The vault-unseal systemd service also sets this via its `Environment=` directive.

If the variable is missing, SOPS fallback will fail with "Age key not found".

## Ansible Installation

The systemd service is installed by Ansible playbook `infra/ansible/playbooks/11-vault-unseal.yml`, which runs during VPS bootstrap. To re-install manually:

```bash
sudo cp /opt/hill90/app/infra/systemd/hill90-vault-unseal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hill90-vault-unseal
```

## After a reboot — the checklist

**As of 2026-07-31 the boot path has never actually run.** The unit became active on
2026-07-26; the host last booted on 2026-07-21, five days earlier. It is enabled and its
key file is in place, but "enabled" is not "exercised" — the same distinction as
*reachable is not working*.

So the first reboot is a test. Run this straight after one, in this order:

```bash
# 1. Platform baseline, BY NAME. A count alone hides which one is missing.
for n in cadvisor grafana keycloak loki node-exporter openbao portainer postgres \
         postgres-exporter prometheus promtail tempo traefik; do
  docker ps --format '{{.Names}}' | grep -qx "$n" || echo "MISSING: $n"
done
docker ps --filter health=unhealthy -q | wc -l          # expect 0

# 2. The unit itself. `is-active` is the answer; the journal says why.
systemctl is-active hill90-vault-unseal                 # expect: active
journalctl -u hill90-vault-unseal -b --no-pager         # expect a successful unseal

# 3. The end state, not the unit's opinion of it.
docker exec openbao bao status | grep -E '^(Initialized|Sealed)'   # Sealed: false

# 4. The retirement held. A reboot must not resurrect a retired service.
docker inspect app-minio --format '{{.State.Status}}'   # expect: exited
docker ps -a --format '{{.Names}}' | grep -cE '^(app-postgres|app-keycloak)$'   # expect: 0

# 5. Exactly ONE router claims the storage host.
#    This is the check nobody thinks to include, and the one that catches a
#    retirement undone by a reboot: app-minio still carries its Traefik labels,
#    so if it came back there would be two routers on one rule — and because
#    both backends are MinIO, the host would answer 200 either way.
for c in $(docker ps -q); do
  docker inspect "$c" --format '{{.Name}} {{index .Config.Labels "traefik.enable"}}' \
  | grep -q true && docker inspect "$c" \
      --format '{{range $k,$v := .Config.Labels}}{{$v}}{{println}}{{end}}' \
  | grep -q 'storage.hill90.com' && docker inspect "$c" --format '  claimant: {{.Name}}'
done                                                    # expect exactly one: /minio

curl -s -o /dev/null -w '%{http_code}\n' https://hill90.com/            # expect 200
curl -s -o /dev/null -w '%{http_code}\n' https://storage.hill90.com/    # expect 200
```

If step 2 says `failed`, that is the design working — see below — and step 3 will tell
you whether it is sealed or something stranger.

### What the unit does now when it goes wrong

`Restart=on-failure` with `RestartSec=30`, bounded by `StartLimitBurst=3` inside a
30-minute window. So:

| Situation | What happens |
|---|---|
| Slow boot | Usually succeeds first attempt; otherwise retries after 30s |
| Missing unseal key | Fails in about a second, three attempts, `failed` within ~90s |
| Hung dependency | Attempts take the full 300s; `failed` at ~17min. It does not spin |

It ends in `failed` and **stays** there rather than looping quietly. That is deliberate:
a retry that hides a persistent failure trades a visible outage for an invisible one.

`ExecStartPost=vault.sh assert-unsealed` is what makes that possible. `auto-unseal`
returns 0 when the container never appears — correct on a fresh VPS, wrong at boot on a
live host, where it would exit 0 with OpenBao still sealed. The assertion separates
"not deployed" (0) from "deployed and still sealed" (1).

## See Also

- [Secrets Architecture](../architecture/secrets-model.md) — vault architecture overview
- [Deployment Runbook](./deployment.md) — full deployment procedures
- [Troubleshooting Guide](./troubleshooting.md) — general troubleshooting
