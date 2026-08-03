# Vault vs SOPS: which is the secrets path?

**Status:** open — this records the evidence and a recommendation. The call is
Jon's.
**Raised:** 2026-07-26 (JON-45)

## What has been done, and what is still open

**Done (2026-07-26):** the `vault-sync-to-sops` schedule is disabled. It had
failed every Monday since 2026-06-01 and could not succeed; a weekly alert that
always fires carries no information. `workflow_dispatch` is kept, so it can
still be run by hand. Reversible with a one-line commit — the re-enable
conditions are written at the schedule block in the workflow.

**Still open — this is the decision for you:** whether the vault should hold
secrets at all. Nothing below has been actioned. Disabling a broken alert is
housekeeping, not a strategic choice, and it was deliberately kept separate
from the question this document exists to answer.

**Not done, deliberately:** the vault has not been reinitialized. That means
destroying a volume and invalidating an unseal key already merged into SOPS,
which is not something to do unattended. The procedure is in
[Reinitializing the vault](#reinitializing-the-vault) below.

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

> **Corrected 2026-08-02 — "cannot mint a new one" was measured with the wrong
> instrument.** `bao operator generate-root` targets the legacy
> `sys/generate-root-token/*` path, which returns 403 regardless of configuration.
> The live endpoint is `sys/generate-root/*`: **405** under production's `config.hcl`,
> **200** with `disable_unauthed_generate_root_endpoints = false` in the **listener**
> stanza, after which root is minted from the unseal key. Root recovery therefore does
> NOT require reinitialising — see
> [`stage2b-oidc-blocked-2026-08-02.md`](stage2b-oidc-blocked-2026-08-02.md) and
> `scripts/vault.sh regain-root`. The reasons not to revoke root early still stand;
> recovery costs a config change, two restarts and a credential-free exposure window.

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
| `HOSTINGER_API_KEY` | VPS management | static, long-lived |
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

> **Read with [platform-primitives.md](platform-primitives.md).** The
> recommendation below asks the vault to justify itself by naming a concrete
> consumer. That framing treats OpenBao as an optional add-on when it is
> deliberately the open-source counterpart to Key Vault — a platform primitive,
> which does not have to point at a current caller to earn its place. The
> operational points below still stand; the "is it worth running at all" framing
> does not.

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

## If vault is chosen: reinitializing the vault

<a id="reinitializing-the-vault"></a>

The vault running today is **inert** — empty, and unconfigurable because its
root token was revoked and OpenBao 2.6.1 cannot mint a new one (403 from
`bao operator generate-root`; the unauthenticated root-generation endpoints are
disabled by default since 2.5.3). The only route to a working vault is to start
it over.

> **Corrected 2026-08-02 — "cannot mint a new one" was measured with the wrong
> instrument.** `bao operator generate-root` targets the legacy
> `sys/generate-root-token/*` path, which returns 403 regardless of configuration.
> The live endpoint is `sys/generate-root/*`: **405** under production's `config.hcl`,
> **200** with `disable_unauthed_generate_root_endpoints = false` in the **listener**
> stanza, after which root is minted from the unseal key. Root recovery therefore does
> NOT require reinitialising — see
> [`stage2b-oidc-blocked-2026-08-02.md`](stage2b-oidc-blocked-2026-08-02.md) and
> `scripts/vault.sh regain-root`. The reasons not to revoke root early still stand;
> recovery costs a config change, two restarts and a credential-free exposure window.


### What it costs

- **The `openbao-data` volume is destroyed.** It contains nothing — no policies,
  no AppRoles, no KV data — so nothing of value is lost. But it is a volume
  deletion on the live host, and it is irreversible.
- **The current unseal key stops working.** A fresh `init` mints a new one, so
  `OPENBAO_UNSEAL_KEY` in SOPS is wrong the moment the old vault is wiped. This
  needs **a second PR** to land the new key, and until it merges the key exists
  only on the host at `/opt/hill90/secrets/openbao-unseal.key`.
- Roughly 20 minutes, most of it waiting on workflow runs and one merge.

### One action, not seven steps

`.github/workflows/vault-reinitialize.yml` runs the whole sequence:

```
gh workflow run vault-reinitialize.yml \
  -f confirm=REINITIALIZE \
  -f i_have_read_the_decision_doc=true \
  -f switch_to_raft=true
```

It does, in this order: back up the volume and verify the archive → wipe →
redeploy (onto raft if asked) → init → unseal → store the key in SOPS → setup →
seed → mint the sync token → prove auto-unseal survives a restart → open a PR
with the new secrets.

**Storage is switched in the same run**, because the volume is being wiped
anyway. Doing it separately means a second outage and an `operator migrate` for
no benefit.

**Root is not revoked.** Revoking it before anything was configured is precisely
what produced the current inert vault. *(Called a one-way door here until
2026-08-03; it is recoverable via `vault.sh regain-root` at the cost of a config change, two restarts and a credential-free window — see
[`stage2b-oidc-blocked-2026-08-02.md`](stage2b-oidc-blocked-2026-08-02.md).)* The
run summary prints the single command to do it once you are satisfied.

It cannot fire by accident. The confirmation input must be exactly
`REINITIALIZE`, a second acknowledgement input must be set, the run refuses if
the vault holds KV data, and it refuses if the pre-wipe backup is missing or
empty.

Two things remain manual afterwards: merge the secrets PR — until then `main`
carries an unseal key for a vault that no longer exists — and revoke root.

### The steps, in order, if you would rather do it by hand

Order matters. Revoking root before `setup-sync-token` is what produced the
current inert vault.

1. **Wipe the volume.** On the host, stop the stack and remove it:
   `docker compose -p hill90-prod-platform -f deploy/compose/prod/docker-compose.vault.yml down -v`
   (or `docker volume rm openbao-data` once the container is gone).
2. **Redeploy** — `gh workflow run deploy-vault.yml`. It will go red at
   `Verify readiness`, because an uninitialized OpenBao returns 501 from
   `/v1/sys/health`. That is expected at this point, not a fault.
3. **Initialize** — `gh workflow run vault-init.yml -f confirm=initialize`.
   Leave `revoke_root` at its default of **false**. The workflow asserts the
   unseal key is `600 deploy:deploy`, stores it in SOPS, proves auto-unseal
   survives a container restart including through the systemd unit, and opens a
   PR with the new key.
4. **Merge that PR.** Nothing after this works from CI until the new
   `OPENBAO_UNSEAL_KEY` is on `main`.
5. **Configure it** — `vault.sh setup` then `vault.sh seed`, with
   `BAO_TOKEN=$(cat /opt/hill90/secrets/openbao-root.token)`. This creates the
   KV engine, the policies and the per-service AppRoles, and populates
   `secret/infra/traefik` and
   `secret/observability/grafana`. There is no workflow for these yet; one
   would need writing, in the shape of `vault-init.yml`.
6. **Mint the sync token** — `vault.sh setup-sync-token`. It writes
   `VAULT_SYNC_TOKEN` into SOPS. That needs another PR to land.
7. **Revoke root** — `vault.sh revoke-root`. Only now. After this the vault
   cannot be reconfigured without repeating this whole procedure.
8. **Re-enable the sync schedule** — restore the `cron` block in
   `.github/workflows/vault-sync-to-sops.yml`, but only after a manual
   `workflow_dispatch` run has gone green.

### If you would rather not

Then nothing needs doing. SOPS is already the operative store, the schedule is
off, and the inert vault costs a few hundred MB and one container. Removing it
entirely is a separate, easy change whenever you want.

## Decision needed: replacing the `file` storage backend (JON-48)

Independent of the vault-versus-SOPS choice above. This one has a deadline set
by someone else.

OpenBao logs this on every start of the live vault (verified on the running
container, v2.6.1):

```
[WARN] storage.file: the file physical backend is deprecated;
use bao operator migrate to move to a supported storage backend by v2.7.0
```

`platform/vault/config.hcl` uses `storage "file"`. Upstream calls it
"a development-only, non-production backend", deprecated in v2.6.0 and
**removed in v2.7.0**. There is no published date for v2.7.0.

`docker-compose.vault.yml` used to pin `ghcr.io/openbao/openbao:2` — a floating
major tag — so this would have broken on a routine image pull rather than a
deliberate upgrade. **It is now pinned to `2.6.1`** (#518), which removes the
ambush but not the underlying problem: the storage backend still has to move
before OpenBao can be upgraded past 2.6.x.

### What to replace it with

Two backends are marked production-ready upstream:

| Backend | Fit for Hill90 |
|---|---|
| **`raft`** (integrated storage) | Recommended upstream "for most use cases", needs no additional software, bootstraps as a cluster of size 1. |
| `postgresql` | Also production-ready, but requires an external Postgres — the one this repo *deleted* in #495. Reintroducing a database to store three secrets would undo the strip. |

**Raft is the answer**, unless the vault is retired entirely.

### The ownership trap (found the hard way, 2026-07-26)

The first raft attempt against production failed and took the vault down:

```
error initializing storage of type raft: failed to create fsm:
failed to open bolt file: open /openbao/raft/vault.db: permission denied
```

Docker copies image ownership into an empty named volume **only when the mount
path already exists in the image**. `/openbao/file` exists and is
`openbao:openbao` (uid 100), which is why the file backend always worked.
`/openbao/raft` does not exist, so Docker created it root-owned and the
unprivileged server could not write.

`docker-compose.vault.yml` now runs a one-shot `openbao-init` service that
chowns the volume to `100:1000` before the server starts, with
`depends_on: service_completed_successfully`. It is idempotent and a no-op for
the file backend.

The lesson is not the chown. It is that the rehearsal which preceded this proved
the *lifecycle ordering* and never exercised the *storage switch*, so the switch
was effectively untested when it ran against production. A rehearsal only covers
what it actually executes.

### What changes in config.hcl

Three edits, all additive:

```hcl
storage "raft" {
  path    = "/openbao/raft"
  node_id = "hill90-vault-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"     # new: raft peer traffic
  tls_disable     = 1
}

cluster_addr = "http://127.0.0.1:8201"  # new: required even for one node
```

`ui`, `disable_mlock`, `api_addr` and the lease TTLs are unchanged.
`disable_mlock = true` stays as it is.

And in `docker-compose.vault.yml`, the volume mount moves with the path:

```yaml
- openbao-data:/openbao/raft     # was /openbao/file
```

Port 8201 does not need publishing or routing — nothing outside the container
talks to it on a single node.

### Can existing data migrate in place?

**Yes.** `bao operator migrate` works at the storage layer with no decryption,
so the encrypted blobs — including the unseal key material and any tokens — are
copied verbatim. **The existing unseal key stays valid.** Documented caveats:

- OpenBao **must be stopped** during the migration.
- The destination **must not already be initialized**.
- The source is left intact apart from a lock key, so it is a safe fallback if
  the migration is abandoned.

The migration config is a small file of its own:

```hcl
storage_source "file" {
  path = "/openbao/file"
}
storage_destination "raft" {
  path    = "/openbao/raft"
  node_id = "hill90-vault-1"
}
```

**But for *this* vault, migrating is the wrong move.** The live vault holds no
policies, no AppRoles and no KV data, and its root token is revoked and
unrecoverable. A faithful migration would preserve exactly that: an empty,
permanently unconfigurable vault, now on raft. There is nothing worth carrying
across.

So the in-place path matters as a general capability and as a fallback — not as
the recommendation here.

### The useful overlap

**If the vault is being reinitialized anyway, switch storage in the same pass
and the migration cost is essentially zero.** The reinit runbook above already
wipes the volume at step 1; changing `config.hcl` and the compose mount before
step 2 means the fresh `bao operator init` bootstraps directly onto raft. No
`operator migrate`, no second outage, no extra PR — two lines of config folded
into work that is already happening.

That is the strongest argument for deciding both questions together rather than
sequentially.

### What it means for unseal and auto-unseal

**Nothing changes.** The seal is unchanged — still a single Shamir key with
`-key-shares=1 -key-threshold=1` — and raft alters where data lives, not how it
is encrypted. `vault.sh unseal`, `vault.sh auto-unseal`, the
`hill90-vault-unseal.service` systemd unit and its `600 deploy:deploy` key-file
check all work unmodified.

One genuine improvement: raft brings `bao operator raft snapshot save` and
`restore`, a consistent point-in-time backup taken from the running server.
`scripts/backup.sh backup vault` currently tars the volume, which is a
crash-consistent copy of files under an active writer. Switching it to a raft
snapshot would be strictly better, and is worth doing at the same time. Note
the tar path would need updating regardless, since the directory moves.

### Does it shift the vault-versus-SOPS calculus?

**Marginally, and not enough to change the recommendation.**

- *Toward keeping the vault:* raft is the supported, production-grade path, and
  it improves backups. It removes the "we are running a dev-only backend"
  objection outright.
- *Toward SOPS:* it is more moving parts — a peer port, a node identity, an
  autopilot subsystem and quorum semantics — in service of a single-node vault
  that currently protects three infrastructure secrets. Single-node raft has a
  failure tolerance of zero, so it buys no availability here.

The recommendation stands: SOPS is the operative store, and the vault should
earn its place by having a concrete consumer. What this deprecation changes is
the *deadline* — the question can no longer be deferred indefinitely, because
inaction eventually breaks the container on an image pull.

### If you decide nothing right now

**The image tag is already pinned** to `2.6.1` (#518), so nothing is on fire and
no upgrade can arrive by surprise. That was the one piece worth doing ahead of
the decision.

What remains is that the vault cannot move past 2.6.x until the storage backend
changes. That is a decision with no deadline attached now — but it is still a
decision, and it will resurface the first time a security fix lands in a version
this pin cannot reach.
