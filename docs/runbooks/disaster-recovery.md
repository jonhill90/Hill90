# Disaster Recovery Runbook

Full platform recovery procedure from total VPS/infrastructure loss.

## Prerequisites

Before starting recovery, ensure you have:

- [ ] Local clone of the Hill90 git repository (up to date with `main`)
- [ ] SOPS encrypted secrets file: `infra/secrets/prod.enc.env`
- [ ] Age private key: `infra/secrets/keys/age-prod.key`
- [ ] Hostinger API access (for VPS creation)
- [ ] Tailscale account access (for network re-join)

## Restore verification — last proven 2026-07-31

The Postgres half of this procedure has been exercised, not assumed. Recorded so the next
person compares against these numbers instead of re-deriving them.

**The artefact restored was the SCHEDULED one**, deliberately — restoring a dump you just
took proves the tool works, not that the nightly job does:

```
/opt/hill90/backups/db/20260731_030002/database.sql
548,439 bytes   mtime 2026-07-31 03:00:12 UTC   sha256 d7be12aa2b73…
```

`20260731_010528` was ignored on purpose: it was a pre-deploy backup taken by hand hours
earlier.

**Where it was restored:** a throwaway `pgvector/pgvector:pg16` container **on the VPS**,
started with `--network none` and a bootstrap superuser named `verifier` so the dump's own
`hill90` and `hill90_app` roles restore without colliding. Removed afterwards with its
volume, both confirmed absent by listing.

**Result: `psql` exit 0, zero stderr lines** — not "errors judged benign", none at all. All
five databases created, and both roles restored with attributes intact, including
`hill90_app superuser=false`, which is the property tenant isolation depends on.

| Database | Restored (03:00 artefact) | Live at time of check |
|---|---|---|
| `hill90_api` | 32 tables / 109 rows | 32 tables / 105 rows |
| `hill90_akm` | 14 tables / 13 rows | 14 tables / 13 rows |
| `hill90_litellm` | 47 tables / 77 rows | 47 tables / 77 rows |
| `keycloak` | 89 tables / 1646 rows | 89 tables / 1660 rows |

Table counts identical throughout. Every row delta was attributed per table rather than
waved at: `hill90_api`'s four extra rows are a transient test fixture (`agents` 1,
`chat_threads` 1, `chat_participants` 2) that existed at 03:00 and was removed afterwards —
the backup faithfully captured short-lived data, which is itself evidence of fidelity. In
`keycloak`, `event_entity` 0→6 and `admin_event_entity` 0→8 reflect login-event storage
being enabled after 03:00, and `offline_user_session` 3→0 is expired `admin-cli` sessions.

Semantic checks on the restored Keycloak, since counts alone would not catch a corrupted
realm: realms `master, platform`; **3** users in `platform`; client `hill90-ui` present with
a **64-character** secret; client roles `admin, user` both present. `hill90_api` carried 65
migrations, 15 tools, 9 skills.

**The negative, which matters as much as the positive: the live instance was never written
to.** All work happened in the throwaway; the live cluster still reported its six databases
afterwards, the platform held 13 containers by name plus MinIO with 0 unhealthy, and
`hill90.com` answered 200. A restore test that touched production would be the worst
possible way to discover that.

**Not verified by this exercise:** that role passwords work after a restore — they are no
longer in the dump, by design, see step 9 — and Grafana, which is not in this dump at all.

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

Deploy Traefik (reverse proxy) and Portainer.

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

> **The dump does not carry role passwords, so a successful restore is not yet a
> working database.** Since 2026-07-31 the dump is taken with `--no-role-passwords`:
> roles are recreated, their passwords are not. Without this step the restore reports
> success and then nothing can authenticate, which reads as a corrupt restore rather
> than a missing action.
>
> Set them from the encrypted store after restoring — `DB_PASSWORD` for `hill90` and
> `HILL90_APP_DB_PASSWORD` for the tenant role `hill90_app` — via
> `ALTER ROLE … PASSWORD`, with the value passed on stdin rather than argv. Verify over
> the **network** from another container, not with `docker exec … psql`, because
> `pg_hba` grants local connections `trust` and will authenticate regardless of the
> password. See
> [platform-postgres-password-rotation.md](platform-postgres-password-rotation.md) for
> the exact shape of both steps.

> **This restores Postgres only. It does NOT restore Grafana.** Grafana keeps its
> state in **SQLite** inside the `grafana-data` volume, not in Postgres — verified
> 2026-07-31: no `grafana` database exists on the platform instance, and
> `/var/lib/grafana/grafana.db` is ~1.8 MB. Grafana's dashboards, users and
> preferences come back from the **observability** volume tar:
> `bash scripts/backup.sh restore observability /path/to/backup`. Sequencing a rebuild
> around the Postgres dump alone leaves Grafana empty.

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
- DNS records may need updating if the VPS IP changed: `bash scripts/cloudflare.sh dns sync`.
