# Rotating the platform Postgres password (`DB_PASSWORD`)

Companion to [keycloak-admin-rotation.md](keycloak-admin-rotation.md). Same shape,
different credential, and two structural differences that change the method. Read
"How to edit the store" before touching `prod.enc.env` — the first attempt at this
rotation produced a branch that would have locked Jon out of the platform and
un-rotated a leaked credential, and it was caught by review rather than by any check
of mine.

## What leaked

`DB_PASSWORD` — the password for role `hill90`, the superuser of the **platform**
Postgres. Printed into an operator transcript on 2026-07-31 by an agent inspecting
`postgres-exporter`'s environment to verify an unrelated claim about scrape targets.
The redaction in use rewrote passwords embedded in a URI (`DATA_SOURCE_URI`) and did
not touch a standalone `DATA_SOURCE_PASS`, which is the form the exporter uses.
Self-reported.

**Not affected: the app's credential.** hill90-app connects as the tenant role
`hill90_app` (NOSUPERUSER, per-database grants), a different role with a different
password held in the app's own store. Note the naming, because it misleads: Hill90's
store has **`DB_PASSWORD`** and there is no `PLATFORM_DB_PASSWORD` in it —
`PLATFORM_DB_PASSWORD` is hill90-app's name for the tenant credential, in the app's
store. Verified by grep: the platform compose files interpolate `${DB_PASSWORD}` for
`POSTGRES_PASSWORD`, `DATA_SOURCE_PASS` and `KC_DB_PASSWORD`.

## Who consumes this value

| Consumer | Variable | Notes |
|---|---|---|
| `postgres` | `POSTGRES_PASSWORD` | **init-only.** Changing the env does NOT change the role; `ALTER ROLE` does. Keeping it in step matters only for a future re-init. |
| `postgres-exporter` | `DATA_SOURCE_PASS` | reconnects per scrape, so it breaks within seconds of `ALTER ROLE` and recovers on redeploy. Observability only. |
| `keycloak` | `KC_DB_PASSWORD` | JDBC pool. Existing connections survive `ALTER ROLE`; **new** ones fail. This decides the ordering. |
| `scripts/backup.sh` | reads `DB_PASSWORD` from SOPS | picks up the new value once the store is on `main`. |

`grafana`'s `GF_SECURITY_ADMIN_PASSWORD` is its own admin credential and unrelated.

## How to edit the store — the rule this rotation earned

**Never round-trip the whole store.** Decrypt-modify-reencrypt rewrites every value's
ciphertext, which does two bad things: it makes the diff unreviewable, and it silently
replaces keys you never intended to touch with whatever your plaintext happened to
contain.

**And never source the store from the VPS checkout.** `/opt/hill90/app` is only reset
to `origin/main` *during a deploy*; between deploys it is arbitrarily stale. On
2026-07-31 it sat at #584 while `main` was at #591 — seven commits behind, missing
#590's rotated `KC_ADMIN_PASSWORD` and both of Jon's account passwords entirely.

The first attempt at this rotation did both. It decrypted
`/opt/hill90/app/infra/secrets/prod.enc.env`, changed one line, and re-encrypted the
result, producing a branch that:

- **deleted** `JON_KC_PASSWORD` and `HILL90ADMIN_KC_PASSWORD` (absent, not empty)
- **reverted** `KC_ADMIN_PASSWORD` from the rotated 32 chars to the leaked 44-char
  value, un-rotating #590

Nothing showed as conflicting, because the conflict was inside an opaque encrypted
blob. The branch was correctly based on current `main`; the *source file* was wrong.
And the verification did not catch it because it compared the new store against the
**same stale file** it was built from — a contaminated control. A key count of "71
before, 71 after" looked reassuring; `main` has **76**.

Do it this way instead:

```bash
# Start from main's file, never the VPS checkout, never a local working copy.
git fetch origin && git show origin/main:infra/secrets/prod.enc.env > prod.enc.env

# sops 3.8.1: --set is a FLAG on the main command. `sops set <file> ...` is 3.9+
# syntax and in 3.8.1 is parsed as "edit this file", which opens vim and fails with
# "no matching creation rules found".
sops --set '["DB_PASSWORD"] "<new value>"' prod.enc.env
```

`--set` re-encrypts only the value you name. The resulting diff is **three lines** —
the value, `sops_lastmodified`, `sops_mac` — and every other value's ciphertext is
byte-identical, so a reviewer can actually see what changed.

### Verifying an edit to the store

Compare against `origin/main`, and compare **structurally**:

```bash
sops -d --input-type dotenv --output-type json <file>
```

Do not parse the decrypted dotenv line by line. Hill90's store contains genuine
multi-line PEM values, so a line-based parser invents keys from PEM body lines —
`-----END PRIVATE KEY-----` and a base64 fragment both show up as keys with empty
values. They appear identically in `main`, so they are pre-existing and not something
an edit introduced, but any check that trips over them is not measuring what it claims
to. (Worth noting: hill90-app has an explicit invariant requiring single-line values
with `\n` escapes for exactly this reason. Hill90's store does not follow it.)

Also run `sops` from a directory with **no** unrelated `.sops.yaml` above the target,
or pass paths that match its `path_regex`. A discovered config whose rules do not match
the filename makes `sops -d` fail with "no matching creation rules found" — and if the
output was redirected to a file, that file is now silently **empty**, which reads as
"every key is missing".

## The trap: local connections are `trust`

`pg_hba.conf` on the platform Postgres, verified 2026-07-31:

```
local   all   all                 trust
host    all   all   127.0.0.1/32  trust
host    all   all   ::1/128       trust
host    all   all   all           scram-sha-256
```

`docker exec postgres psql -U hill90` proves **nothing** about a password: it takes the
`local` line and authenticates with `trust`. Every proof here connects **over the
network** from a separate container on `hill90_internal`, which takes the
`scram-sha-256` line.

`log_statement = none` and `log_min_duration_statement = -1`, so `ALTER ROLE ... PASSWORD`
does not reach the Postgres log. Confirm that is still true before running it.

## Why this is two-phase

`reusable-deploy-service.yml` runs `git reset --hard origin/main` on the VPS checkout
before deploying, so every deploy uses **main's** copy of the store. There is no `ref`
input that changes this and deploying from a workstation is forbidden. **The rotation
therefore cannot complete until the store change is merged.**

The obvious escape — write the new value to OpenBao, which `deploy.sh` consults before
SOPS — is not available, and why is a finding in its own right.

### Finding: the vault-first path is nominal, not real

`vault_login` reads `VAULT_<SVC>_ROLE_ID` and `VAULT_<SVC>_SECRET_ID` from the SOPS
store. **Those keys are not in it.** Measured against the live code path on the VPS on
2026-07-31:

```
vault_available: YES
VAULT_(DB|AUTH)_(ROLE_ID|SECRET_ID) present in SOPS: 0/4
[db] login FAILED
[auth] login FAILED
[infra] login FAILED
[observability] login FAILED
```

Every production deploy takes the `warn "OpenBao available but login failed for <svc>,
falling back to SOPS"` branch. OpenBao is unsealed, healthy, and **not in the secret
path at all**. Related: `scripts/vault.sh` binds each AppRole to `policy-<svc>`, but only
`policy-admin`, `policy-infra`, `policy-observability`, `policy-oidc-admin` and
`policy-sync` exist under `platform/vault/policies/` — no `policy-db`, no `policy-auth`.
`cmd_seed` also never writes `secret/shared/database`, though
[secrets-workflow.md](secrets-workflow.md) documents it.

Whether to repair or formally retire that path is a platform decision and is NOT part
of this rotation. It is recorded because it silently converts a documented "Vault
primary, SOPS backup" design into SOPS-only, and because it is why a merge is the gate.

## Phase 1 — prepare

New value: 32 characters, `[A-Za-z0-9]` only. No punctuation, no base64 padding, nothing
a shell, a `printf '%q'` requote or a SOPS round-trip can mangle. Generated straight to a
0600 file with `tr -dc 'A-Za-z0-9' < /dev/urandom`; never echoed, plaintext shredded once
encrypted. The store is the only carrier — re-derive it with `sops -d` when Phase 2 needs
it.

What to prove before opening the PR, all against `origin/main`:

- 76 keys before, 76 after; **no** key lost, **no** key added
- exactly one changed value, `DB_PASSWORD`
- `JON_KC_PASSWORD`, `HILL90ADMIN_KC_PASSWORD` and `KC_ADMIN_PASSWORD` all present at
  32 characters and **byte-identical to main**
- `KC_ADMIN_PASSWORD` authenticates against the live Keycloak, with a wrong value
  refused in the same run. Safe as a negative control because master has
  `bruteForceProtected=false`, `permanentLockout=false` — check that first
- the new value is 32 bytes, matches `^[A-Za-z0-9]{32}$`, and differs from the old one
- the plaintext value appears nowhere in the encrypted file

Jon's two account passwords are verified by **presence, length and byte-identity to
main only**. Do not authenticate as Jon to test them.

## Phase 2 — execute (only after the store change is merged to `main`)

Ordering is chosen for the failure window. `ALTER ROLE` must come first: until it runs, a
redeployed consumer holds a password the server rejects. Keycloak's JDBC pool survives
`ALTER ROLE` — only new connections fail — so `auth` is redeployed next, before anything
restarts Postgres and forces its pool to reconnect. `db` is last because deploying it
recreates the Postgres container and drops every pool, including the app's.

```bash
# 0. Baseline: old value must still authenticate over the NETWORK, and a wrong value
#    must be refused, or the test cannot tell them apart.
docker run --rm --user "$(id -u)" --network hill90_internal \
  -e PGPASSWORD="$(sops -d infra/secrets/prod.enc.env | sed -n 's/^DB_PASSWORD=//p')" \
  pgvector/pgvector:pg16 psql -h postgres -U hill90 -d hill90 -tAc 'select current_user'

# 1. Change the role's password. Value via file and stdin, never argv.
docker exec -i postgres psql -U hill90 -d postgres -f - < /path/to/alter.sql

# 2. Keycloak, through the pipeline.
gh workflow run "Deploy Auth (Prod)" -f dry_run=true   # then for real

# 3. Postgres + exporter, through the pipeline. Recreates the container.
gh workflow run "Deploy DB (Prod)" -f dry_run=true     # then for real
```

Note for any container that must read a 0600 file from a bind mount: pass
`--user "$(id -u)"`, or curl inside the image runs as a different uid and fails with
"error encountered when reading a file".

### Both directions, or it is half a rotation

- the NEW value, taken **from the store on `main`** rather than from an operator's hand,
  authenticates over the network from a separate container
- the OLD leaked value is **REFUSED**
- `keycloak` healthy, `hill90.com` still redirecting to `auth.hill90.com/realms/platform`
- `postgres-exporter` healthy and scraping
- the app's 8 containers healthy and still serving as `hill90_app` — its credential is
  untouched, but the Postgres restart drops its pools, so reconnection is verified
- platform baseline: 13 containers by name, 0 unhealthy, `hill90.com` 200

If a consumer breaks, **roll forward** with the new value. Do not restore the leaked one;
it is the thing being destroyed.

## Afterwards

Delete `/opt/hill90/secrets/rotate-db-20260731/`. It holds the old value in plaintext at
0600, kept only so Phase 2 can prove the old credential is refused, and has no purpose
once that proof exists.
