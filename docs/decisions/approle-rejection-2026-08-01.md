# Every AppRole in the store is rejected by OpenBao

`Measured 2026-08-01 02:5x UTC, read-only. Nothing was repaired, and that is deliberate —
this record is written BEFORE any repair, because a repair erases the evidence.`

## What was measured

All nine AppRole credentials in `infra/secrets/prod.enc.env` were used to log in to the
running OpenBao. **All nine were rejected.**

```
AI             FAILED   Code: 400
API            FAILED   Code: 400
AUTH           FAILED   Code: 400
DB             FAILED   Code: 400
INFRA          FAILED   Code: 400
MCP            FAILED   Code: 400
MINIO          FAILED   Code: 400
OBSERVABILITY  FAILED   Code: 400
UI             FAILED   Code: 400
```

The full error, taken from the `infra` attempt:

```
Error writing data to auth/approle/login: Error making API request.
URL: PUT http://127.0.0.1:8200/v1/auth/approle/login
Code: 400. Errors:
* invalid role or secret ID
```

This is a rejection by OpenBao, not a transport failure. Both identifiers are present in
the store and well-formed — `role_id` and `secret_id` are each 36 characters, the length of
a UUID — so the values exist and are the right shape. They simply do not match what OpenBao
holds.

Context measured at the same time, because it bounds the recovery:

| Path | Result |
|---|---|
| `bao operator generate-root -init` | **403 permission denied** |
| `POST sys/generate-root/attempt` *(added 2026-08-02)* | **405** under `config.hcl` — the CLI row above used a legacy path and overstated the block; see [`stage2b-oidc-blocked-2026-08-02.md`](stage2b-oidc-blocked-2026-08-02.md) |
| root token file `/opt/hill90/secrets/openbao-root.token` | **absent** |
| `VAULT_SYNC_TOKEN` from the store | **did not validate** |
| `bao read auth/oidc/role/admin-sso` | fails without a token |
| write to `auth/oidc/role/admin-sso` with no token | **403** |
| OpenBao itself | `Initialized true`, `Sealed false`, `Version 2.6.1` |
| `/opt/hill90/secrets/openbao-unseal.key` | present, 44 bytes, `0600 deploy:deploy` |

The vault is healthy and unsealed. **Unsealing and administering are different things**, and
only the first is currently demonstrated.

## The cause is NOT diagnosed

`invalid role or secret ID` is a single error covering several distinct faults, and nothing
measured here distinguishes between them. The candidates, none eliminated:

- **Secret IDs consumed.** AppRole `secret_id`s can be single-use or use-limited. If the
  stored values were spent, every subsequent login fails exactly like this.
- **Secret IDs expired.** They carry a TTL. An elapsed TTL produces the same error.
- **Roles recreated without updating the store.** If the AppRole roles were re-created, the
  `role_id`s change, and the stored ones become stale — again the same error.

A fourth possibility not excluded: the `approle` auth mount itself was re-enabled at some
point, which invalidates every role under it.

**Do not read this document as saying which it is.** Determining that requires an
authenticated session, which is the thing that is missing.

## What this does and does not tell us about deploys

`scripts/deploy.sh` is vault-first with a SOPS fallback. Both call sites — line 159 for
`infra`, line 416 for the other services — have the shape:

```sh
if vault_available; then
    if (vault_login "$service" "$secrets_file") >/dev/null 2>&1; then
        vault_ok=true
    else
        warn "OpenBao available but login failed for ${service}, falling back to SOPS"
    fi
```

`vault_available` tests only that the vault is reachable and unsealed — which it is — so on
this evidence the login attempt is reached and fails, and the deploy proceeds on SOPS.

**That last step is inference from the code path, not an observation, and the distinction
matters.** Three deploys ran on 2026-08-01 (runs `30680527711`, `30680352147`) and
2026-07-31 (`30630028229`), all reporting success. **I could not evidence the fallback from
their logs:** `gh run view --log` returned 667 lines for the most recent run with **zero**
lines matching `openbao` or `vault`, case-insensitively, and none matching the deploy
script's own progress output either. The deploy runs as
`ssh … "bash scripts/deploy.sh <service> prod"`, so that output is expected in the log and
was not found.

So one of two things is true, and this record does not settle which:

1. the deploys did fall back to SOPS and the step output is simply not being captured in the
   workflow log, or
2. the deploys did not take the vault path at all.

Either is worth knowing. **The second would be the more interesting finding**, because it
would mean the vault-first path is not exercised in production at all and its breakage was
never going to surface.

## Why this shape is the dangerous one

Whatever the answer above, the design intent is a credential path that authenticates,
fails, silently falls back, and reports success. A fallback that keeps deploys working is
good engineering. A fallback that keeps them working **without anyone learning the primary
path is dead** is how a broken authentication path survives indefinitely — the same shape
as the three consecutive silent backup failures (#563), and as the six instrument failures
recorded in `CONTRIBUTING.md`.

Nothing in this estate currently asserts that the vault path works. The health check tests
that OpenBao is unsealed, which it is.

## Recorded, not repaired

No repair was attempted before writing this. The next step — generating a root token by the
documented procedure, diagnosing the cause, and repairing — is deliberately a separate
change, so that the evidence above is not overwritten by the fix.

The OpenBao OIDC binding remains on the old `realm_roles: ["admin"]` value. Stage 2b and
Stage 3 of the permission-model work are not started.
