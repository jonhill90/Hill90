# Vault vs SOPS: which is the secrets path?

**Status:** open — this records the evidence and a recommendation. The call is
Jon's.
**Raised:** 2026-07-26 (JON-45)

## What is actually true today

**Updated 2026-07-26, after JON-45.** The vault now exists again — but it is
empty, and nothing reads from it. The argument below is unchanged by that,
because it was never about whether a vault *could* run.

- OpenBao is deployed, initialized, unsealed and healthy as of 2026-07-26.
  Auto-unseal survives a container restart, verified through the systemd unit.
  `OPENBAO_UNSEAL_KEY` is now in SOPS and at `/opt/hill90/secrets/openbao-unseal.key`
  (`600 deploy:deploy`). The root token was revoked immediately.
- **It holds no policies, no AppRoles and no KV data.** `setup` and `seed` have
  not been run. Every deploy still falls back to SOPS, which the green
  `deploy-vault` run logged explicitly.
- **And it cannot currently be configured.** The root token was revoked right
  after init, and on OpenBao 2.6.1 `bao operator generate-root` returns 403 —
  the unauthenticated root-generation endpoints are disabled by default since
  2.5.3. With no other sudo-capable token, the only route back to root is
  reinitializing. So the running vault is not just empty, it is inert until
  someone decides to reinitialize it.
- Between the June 14 rebuild and 2026-07-26 there was no vault at all, and
  nothing noticed.
- Every secret in use has been served by SOPS + age for six weeks. Nothing
  broke, and nothing noticed.
- `deploy.sh` is vault-first with a SOPS fallback. With no vault present,
  `vault_available()` returns non-zero and every deploy silently takes the SOPS
  path (`scripts/_common.sh:102-106`). That fallback is why the absence went
  unremarked.
- `hill90-vault-unseal.service` is enabled and active. It exits cleanly when the
  container is absent, so it has been a no-op since June.
- The weekly `vault-sync-to-sops` workflow failed every run from 2026-06-01 to
  2026-07-20 at `Verify SSH connectivity` — it never reached the vault. That
  has since resolved: as of 2026-07-26 it gets past SSH and fails later, at
  `Renew sync token`, with `403 permission denied`, because `VAULT_SYNC_TOKEN`
  in SOPS belongs to the vault that was destroyed in June. See JON-46.
- SOPS still holds seven AppRole credential pairs (`VAULT_DB_*`, `VAULT_API_*`,
  `VAULT_AI_*`, `VAULT_AUTH_*`, `VAULT_UI_*`, `VAULT_MCP_*`, `VAULT_MINIO_*`)
  for services deleted in JON-27/28. They are dead weight whichever way this
  goes.

## What is actually being protected

After the application strip, the live stacks are `infra` and `observability`.
Between them the secrets are roughly:

| Secret | Consumer | Shape |
|---|---|---|
| `TRAEFIK_ADMIN_PASSWORD_HASH` | Traefik dashboard | static, a bcrypt hash |
| `HOSTINGER_API_KEY` | dns-manager | static, long-lived |
| `GRAFANA_ADMIN_PASSWORD` | Grafana | static |
| `ACME_EMAIL` | Traefik | not really a secret |

All static. All read once, at deploy time. None rotated automatically today.

## The case for each

**Keep vault-first.** It is already written and it works. Per-service AppRoles
give scoped access, there is an audit log, and revocation is possible. If the
homelab grows something that needs dynamic credentials — a database, an
application with per-environment secrets — the machinery is there rather than
being a migration.

**Make SOPS the documented path.** Three arguments, in increasing order of
weight:

1. *Nothing exercises what vault is for.* Four static values read at deploy
   time use none of leasing, dynamic credentials, or revocation. The audit log
   records a single AppRole login per deploy.

2. *The operational burden is not small.* An unseal key that must exist in two
   places and be backed up, a systemd unit with boot-order sensitivity, AppRole
   bootstrap, root-token handling, a weekly sync job, and a volume that needs
   its own backup. Each is a thing that can be wrong at 3am.

3. *Vault's own disaster-recovery backup is SOPS.* This is the decisive one.
   The unseal key lives in SOPS; the sync job exists to copy vault's contents
   back into SOPS. So SOPS is already the root of trust and the recovery path.
   Vault is a layer above something that must remain authoritative anyway — and
   the job that keeps the two in step has never once succeeded.

## Recommendation

**Document SOPS as the active path. Keep the vault code, dormant.**

Not "remove vault" — the implementation is decent and deleting it would be
throwing away working code for no gain. But stop asserting a model that is not
running, which is what
[secrets-model.md](../architecture/secrets-model.md) did until this change.

Reintroduce vault when there is a concrete consumer that needs something SOPS
cannot do: dynamic credentials, short-lived leases, per-service revocation, or
a real audit requirement. "It is good practice" is not that reason at this
scale; six weeks of uneventful SOPS operation is evidence, not an accident.

One legitimate counter-argument: this is a homelab, and running OpenBao for the
experience of running OpenBao is a perfectly good reason. If that is the reason,
it is worth making it explicitly — a deliberate "I want to operate a vault"
rather than a default the documentation asserts on the reader's behalf.

## If SOPS is chosen

- Prune the seven stale AppRole pairs from SOPS.
- Disable or delete the `vault-sync-to-sops` schedule. It has alerted failure
  weekly since June; the alert has stopped carrying information.
- Keep `scripts/vault.sh`, the compose file and the policies. Leave the
  vault-first fallback in `deploy.sh` — it costs one failed `docker exec` per
  deploy and means enabling vault later needs no code change.

## If vault is chosen

- JON-46 must be fixed first: CI cannot currently reach the VPS at all, so
  neither the deploy nor the sync can run.
- `vault.sh init` needed fixing before it was safe to run — it printed the
  unseal key and root token. Done in PR #499.
- There is still no non-SSH path to run `init`. Either add an init workflow or
  accept a one-off manual initialization.
