# Disaster Recovery Runbook

Full platform recovery procedure from total VPS/infrastructure loss.

## Prerequisites

Before starting recovery, ensure you have:

- [ ] Local clone of the Hill90 git repository (up to date with `main`)
- [ ] SOPS encrypted secrets file: `infra/secrets/prod.enc.env` — **this is committed**,
      so the clone brings it
- [ ] Age private key: `infra/secrets/keys/age-prod.key` — **this is NOT committed and is
      in no backup.** See Step 0; get it before anything else
- [ ] Hostinger API access (for VPS creation)
- [ ] Tailscale account access (for network re-join)

<a id="step-0"></a>
## Step 0 — Get the age key. Nothing else works first.

**Do this before touching a host.** Every step below that reads a secret depends on it,
and it is the one input that no backup, snapshot or tar can give you.

The recovery chain is:

```
age private key  →  decrypts infra/secrets/prod.enc.env  →  yields OPENBAO_UNSEAL_KEY
                 →  unseals the restored openbao-data volume  →  vault is usable
```

Read it right-to-left to see the failure: **the vault tar is inert without the age key.**
You can restore `openbao-data.tar.gz` perfectly and still have nothing, because the volume
is ciphertext and the unseal key that opens it is itself inside a SOPS file you cannot
decrypt.

**Where the key is, and is not.** `Verified 2026-07-31 08:12 UTC.`

| Location | Present? | Survives total VPS loss? |
|---|---|---|
| Password manager | The intended durable copy, per [`docs/reference/secrets.md`](../reference/secrets.md). **Inferred from that document, not verified here** — nothing on a host can confirm it, which is the point | **Yes** — the only copy the DR scenario can rely on |
| Operator workstation, `infra/secrets/keys/age-prod.key` | Yes, gitignored | Only if the workstation is intact. It is not part of the recovery guarantee |
| VPS, `/opt/hill90/secrets/keys/keys.txt` (`0600 deploy:deploy`) | Yes | **No** — this is the host you just lost |
| Git | **No**, and must stay that way — only `age-prod.pub` is tracked | n/a |
| Any backup tar | **No.** `backup_volume` tars Docker volumes; `/opt/hill90/secrets/` is a host path, so no target reaches it | n/a |

That last row is a deliberate design property, not an oversight: a backup containing the
key that decrypts the estate is a backup that cannot be stored anywhere safely. The cost
of that choice is this step, and it is why it is written here rather than assumed.

**The unseal key is not the single point of failure — the age key is.** `OPENBAO_UNSEAL_KEY`
is present in the committed `infra/secrets/prod.enc.env` (confirmed 2026-07-31 by reading
the key *name* from the encrypted file, whose dotenv format keeps names in plaintext and
values as ciphertext; the value was not decrypted or printed). So losing the on-host
`openbao-unseal.key` costs nothing. Losing the age key costs everything downstream of it.

If you reach this runbook at 3am with a dead VPS: **open your password manager first.**

Coverage for every other volume, and what each uncovered one costs, is in
[`docs/reference/backup-coverage.md`](../reference/backup-coverage.md).

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
longer in the dump, by design, see step 9. Grafana is not in this dump at all, and is
covered by the separate exercise below.

## Volume-tar restore verification — observability, 2026-07-31

The Postgres exercise above proves a **dump** restores. It says nothing about the volume
tars, which are the only artifact behind five of the six backup targets. So that was
exercised too.

**The artefact restored was again the SCHEDULED one:**

```
/opt/hill90/backups/observability/20260731_030038/grafana-data.tar.gz
13,160,853 bytes   written 2026-07-31 03:00 UTC
```

**Where:** a throwaway Docker volume, not `grafana-data`. The live volumes were never
written to. The throwaway was removed afterwards and its absence confirmed by listing.

**Result:** `grafana.db` came back at 1,880,064 bytes. The platform baseline held
afterwards at 13 containers by name plus `minio`, **0 unhealthy** — re-confirmed
`Verified 2026-07-31 08:12 UTC`, with the tenant's 7 containers alongside for 21 total.

> **This run got lucky rather than being safe, and the tar itself shows it.**
> `grafana.db`'s recorded mtime inside the archive is **02:52** — eight minutes before the
> 03:00 tar — and no `grafana.db-journal` was present. Grafana writes SQLite in
> rollback-journal mode, so a tar that starts *during* a write transaction can capture a
> torn database, or a database without the journal that would repair it. Nothing in
> `backup_volume` prevents that; the container is not stopped, paused or frozen. The clean
> restore is evidence that the artifact was intact **that night**, not evidence that the
> mechanism is safe.

**What this exercise does not prove:** that Grafana *starts* against the restored volume
and renders its dashboards — the restore was verified at the file level, in a throwaway,
without pointing a Grafana at it. (A later exercise did start Grafana against an **empty**
volume, which is a different question and is why the restore matters less than it looks —
see [`backup-consistency-options.md`](../decisions/backup-consistency-options.md).) And it
says nothing about `openbao-data`,
`prometheus-data` or `prod_minio-data`, whose exposure to the same problem is larger
because they are written continuously. OpenBao has a proper fix available — a raft
snapshot, taken from the running server — costed in
[`vault-vs-sops.md`](../decisions/vault-vs-sops.md).

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

### 8. Configure OIDC (Keycloak)

Enable and bind OpenBao's OIDC auth method against the platform Keycloak realm:

```bash
bash scripts/vault.sh setup-oidc
```

Reuses the `BAO_TOKEN` already exported for Step 6 — no need to export it again.
Requires `VAULT_OIDC_CLIENT_SECRET` in SOPS (already present in the production
store); the command refuses loudly rather than proceeding if it is missing.

> **This step exists because `vault.sh revoke-root` — used in Step 13 below, and
> called internally by `bootstrap-approles` in Step 9 — refuses to run without
> it.** `assert_safe_to_revoke` (`scripts/vault.sh:244`) checks whether OIDC is
> enabled before permitting a root-token revoke, because revoking root without
> OIDC configured is **irreversible on OpenBao >= 2.5.3**: the unauthenticated
> root-generation endpoints are disabled by default, so nothing can enable OIDC
> afterward without redeploying on a recovery config, two vault restarts, and a
> window in which an unseal key share alone mints root (`vault.sh regain-root`).
>
> Not a hypothetical — the guard's own comment names two prior occurrences of
> exactly this: 2026-07-26, and again on 2026-08-02 by "the documented recovery"
> this file describes. Skipping this step does not just skip OIDC; it reproduces
> that failure a third time, at Step 9 or Step 13, in the middle of a recovery.

### 9. Generate and Store AppRole Credentials

Bootstrap all AppRole credentials automatically:

```bash
bash scripts/vault.sh bootstrap-approles
```

This generates role_id + secret_id for the services in `VAULT_SERVICES` and stores
them in SOPS. It temporarily generates a root token (via unseal key), runs setup,
creates credentials, then revokes the root token — through the same
`assert_safe_to_revoke` guard as Step 13, so it also depends on Step 8 above having
run first.

> **There are FIVE, not nine.** `Verified 2026-08-05` against `scripts/vault.sh:31`,
> which is the source of truth:
>
> ```sh
> VAULT_SERVICES="db auth infra observability sync"
> ```
>
> This line previously said "all 9 services". It was wrong, and wrong in the
> document someone follows while rebuilding from nothing — expecting nine and
> finding five during a rebuild is exactly the wrong moment to discover a count
> is fictional.
>
> **`minio` and `vault` deliberately have no AppRole.** They are not in
> `VAULT_SERVICES` and never have been, so their deploys legitimately fall back
> to SOPS. A deploy log line reading `WARNING: OpenBao available but login failed
> for minio, falling back to SOPS` is the **designed** behaviour for those two,
> not a fault — see #791, where that warning was first read as credential decay.
>
> Corroborated independently: the root-level enumeration in
> [`auth-outage-2026-08-03.md`](../decisions/auth-outage-2026-08-03.md) lists the
> AppRoles that actually exist in the vault as `db`, `auth`, `infra`,
> `observability`.

### 10. Deploy Database

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

> **This restores Postgres only, and Grafana is not in it.** Grafana keeps its state in
> **SQLite** inside the `grafana-data` volume, not in Postgres — verified 2026-07-31: no
> `grafana` database exists on the platform instance, and `/var/lib/grafana/grafana.db` is
> ~1.8 MB.
>
> **But do not sequence a rebuild around restoring that volume — you almost certainly do
> not need to.** This entry used to say Grafana's "dashboards, users and preferences come
> back from the observability volume tar" and that a Postgres-only restore "leaves Grafana
> empty". Both overstate it, and the second is false. `Verified 2026-07-31 08:26 UTC` by
> starting Grafana 11.6.0 against an **empty** volume and this repository's provisioning
> directory: it came up with all **6 dashboards** and all **3 datasources**, because they
> are provisioned from files in `platform/observability/grafana/provisioning/` — every live
> dashboard carries a `dashboard_provisioning` row, so none was made in the UI. Alert rules,
> annotations, stars, preferences, folders, playlists, teams and API keys are **0 in both**.
>
> What the volume tar uniquely holds is **one user row** — `jon@hill90.com`, created by
> OAuth — and two session tokens. The `admin` user is rebuilt from `GF_SECURITY_ADMIN_*`,
> which comes from `GRAFANA_ADMIN_PASSWORD` in the encrypted store. So the honest
> instruction is: **deploy observability normally and let it provision.** The OAuth user
> reappears at the next sign-in.
>
> The restore is still available if you want that user row and the session state back
> without a login — `bash scripts/backup.sh restore observability /path/to/backup` — but it
> is a convenience, not a step. Full evidence in
> [`backup-consistency-options.md`](../decisions/backup-consistency-options.md).

### 11. Deploy All Services

```bash
bash scripts/deploy.sh all prod
```

### 12. Verify Health

```bash
bash scripts/ops.sh health
```

Check each service endpoint responds correctly.

### 13. Revoke Root Token

```bash
bash scripts/vault.sh revoke-root
```

> **Not the raw `docker exec ... bao token revoke -self` this step used to
> document.** That call went straight to the OpenBao API with no safety check.
> `vault.sh revoke-root` runs the identical revoke through `assert_safe_to_revoke`
> first (see Step 8 above), which refuses rather than leaving a permanently
> unconfigurable vault if OIDC somehow isn't enabled by this point. It also reads
> the root token from `$ROOT_TOKEN_PATH` on the host instead of requiring it typed
> into a command, and independently confirms the token is dead afterward rather
> than trusting the API's own always-0 exit code.
>
> If Step 9 (`bootstrap-approles`) already completed, it will have revoked this
> same root token itself. `vault.sh revoke-root` reports "nothing to revoke" and
> exits 0 in that case — expected, not an error.

### 14. Post-Recovery: Sync Vault to SOPS

Confirm the SOPS backup reflects the current vault state:

```bash
export BAO_TOKEN="<admin-token>"
bash scripts/vault.sh sync-to-sops
```

## Recovery Order Summary

```
VPS recreate -> VPS config -> infra -> vault (deploy+init+unseal+setup+seed)
  -> OIDC config -> AppRole creds -> db (+ restore) -> all services -> health check
  -> revoke root token -> sync vault to SOPS
```

## Notes

- Vault auto-unseals after deploy (`deploy.sh vault` calls `vault.sh auto-unseal`) and on VPS boot (systemd `hill90-vault-unseal` service). Manual unseal is available as fallback: `bash scripts/vault.sh unseal`.
- SOPS is the bootstrap mechanism. All runtime secrets must be present in SOPS to seed vault on a fresh install.
- `SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt` must be set in the deploy user's environment for SOPS fallback to work. The Ansible bootstrap (playbook 12) configures this automatically.
- After recovery, run `vault.sh sync-to-sops` periodically to keep the SOPS backup current.
- DNS records may need updating if the VPS IP changed: `bash scripts/cloudflare.sh dns sync`.
