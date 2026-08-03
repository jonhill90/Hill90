# Stage 2b is blocked: the vault has no OIDC auth method, and no way to acquire one

`Measured 2026-08-02 against production. Read-only — nothing was deployed, created or
changed on the host.` Every command below was run over SSH as `deploy` and every one of
them only reads.

**Stage 2b — repointing OpenBao's `admin-sso` OIDC role from realm role `admin` to
`platform-admin` — cannot be completed.** Not because the change is wrong; because there
is no OIDC auth method on the production vault to repoint, and enabling one needs a
root-or-sudo token that does not exist and cannot be minted.

This is the 2026-07-26 one-way door, standing open again. #645 closed the door on
*future* revokes; it landed **after** #643 had already walked through it.

## The verdict, and the four facts behind it

| Question | Answer | How |
|---|---|---|
| Is the OIDC auth method mounted? | **No** | unauthenticated probe with both controls — below |
| Is the on-disk root token usable? | **No** — `403 permission denied` | `bao token lookup` with `/opt/hill90/secrets/openbao-root.token` |
| Can root be regenerated? | **No** — `403 permission denied` | `bao operator generate-root -init` and `-status` |
| Can any AppRole enable it? | **No** — `deny` on all four | `bao token capabilities sys/auth/oidc` after a real login |

Any one of those would be recoverable. Together they are the closed door.

## Fact 1 — OIDC is not mounted, and the instrument was controlled before it was believed

There is no token, so `bao auth list` is unavailable — which is exactly why this was
unanswerable until now. The probe instead reads the status of an unauthenticated POST:

```
positive control  auth/approle/login                -> 500   (mounted; backend rejected the payload)
negative control  auth/no-such-method-3594870/login -> 403   (absent; no handler)
target            auth/oidc/oidc/auth_url           -> 403   (matches the ABSENT control)
```

**403, not 404, is what OpenBao returns for a mount that does not exist**, which is
counter-intuitive enough that the reading is worthless without the pair of controls. Both
behaved, so the target's 403 means absent. Shipped as
`scripts/checks/vault-oidc-enabled-test.sh`, which refuses to report a verdict at all if
either control misbehaves.

**A second, independent instrument agrees.** The barrier-encrypted auth mount table is a
single file in the storage backend, and while its contents are unreadable its *mtime* is
not:

```
-rw-------  openbao  561  Aug  2 23:48  /openbao/file/core/_auth
```

`23:48` is the rebuild. Nothing has been added to the auth mount table since — no
`setup-oidc` ran during #643, and none has run since. (`sys/policy/` is `23:51`, so
`policy-apply` did run; policies are not auth methods.)

## Fact 2 — the root token file survives, and the token in it is dead

```
-rw------- 1 deploy deploy 26 Aug  2 23:48 /opt/hill90/secrets/openbao-root.token
```

The file's existence is misleading and worth stating plainly, because a future session
will find it and think it has root:

```
Error looking up token: ... Code: 403. Errors: * permission denied
```

`bootstrap-approles` revoked the token in-place when it finished — the unconditional
revoke that #645 later removed — but it revokes with `token revoke -self` and never
touches the file. Only `vault.sh revoke-root` deletes it, and that was never run. So the
host holds a 0600 file containing a dead credential. **A root token file on disk is not
evidence of root access.**

## Fact 3 — `generate-root` is closed, and today's 403 does not by itself prove why

```
PUT /v1/sys/generate-root-token/attempt -> 403 permission denied
GET /v1/sys/generate-root-token/attempt -> 403 permission denied
```

The estate's existing record says this was verified on 2.6.1 "with the flag set at
listener and at top level" (`docs/runbooks/vault-unseal.md`). **Be precise about what
today's measurement adds and what it does not.** The live config carries no such flag:

```hcl
ui = true
disable_mlock = true
storage "file" { path = "/openbao/file" }
listener "tcp" { address = "0.0.0.0:8200"  tls_disable = 1 }
api_addr = "https://vault.hill90.com"
```

So today's 403 is the **documented default** for OpenBao ≥ 2.5.3, not a re-proof that
overriding the default fails. The option is real and top-level — confirmed by name in the
2.6.1 binary itself, `disable_unauthed_generate_root_endpoints`, alongside its
`DisableUnauthedGenerateRootEndpointsRaw.hcl` struct tag.

**That leaves exactly one untried lever**, and it is Jon's call, not this session's:
set `disable_unauthed_generate_root_endpoints = false` in `config.hcl`, deploy through
the pipeline, restart OpenBao, and mint root with the unseal key — which is present, at
threshold 1 of 1. If it works, Stage 2b proceeds with no data loss and no reinitialise.
The prior negative result argues it will not, but that result predates this and its own
wording ("at listener and at top level") suggests the flag's placement was uncertain at
the time. **It was not tested here**: it changes production config and restarts the
platform's vault, which is a deploy and beyond a read-only diagnosis.

## Fact 4 — AppRole is healthy, and is not a way in

All four platform AppRoles authenticate. This is also the Stage 2b post-check the runbook
asks for, so it is recorded as a result in its own right:

| Service | Login | Policies | `sys/auth/oidc` |
|---|---|---|---|
| `infra` | OK | `['default', 'policy-infra']` | **deny** |
| `db` | OK | `['default', 'policy-db']` | **deny** |
| `auth` | OK | `['default', 'policy-auth']` | **deny** |
| `observability` | OK | `['default', 'policy-observability']` | **deny** |

Enabling an auth method is `sys/auth/oidc`, and **no policy in this repo grants it** —
not even `policy-admin`, the break-glass one, which grants `auth/*` but not `sys/auth/*`.
`auth/*` and `sys/auth/*` look alike and are not: one operates *within* a mounted method,
the other *creates* one. Nothing is bound to `policy-admin` in any case.

`VAULT_SYNC_TOKEN` in SOPS is also rejected (`permission denied`) — the pre-rebuild value,
never regenerated.

## Everything on the Keycloak side is already correct

The blockage is entirely OpenBao's. Measured the same day, read-only:

- `jon` holds realm roles `default-roles-platform` and **`platform-admin`** — Stage 1
  (#636) is live.
- Client `hill90-vault` exists, with mapper `realm-roles`,
  `oidc-usermodel-realm-role-mapper`, **`claim.name=realm_roles`** — the deliberate
  non-default, unchanged.

So the moment an OIDC method exists, `setup-oidc` writes a role binding
`{"realm_roles": ["platform-admin"]}` against a claim that is emitted and a role that
`jon` holds, and the login should work. **"Should" is doing real work in that sentence —
it has not been tested, and nothing here may be cited as if it had.**

## What this PR changes, and what it deliberately does not

**Changed:** `scripts/vault.sh` now binds `platform-admin` instead of `admin`, matching
Grafana's repoint in #637. The claim NAME stays `realm_roles` — #635 measured that binding
as already consistent, and renaming the mapper was the fix that would have changed
nothing. Two stale comments quoting the old value are corrected, in `scripts/keycloak.sh`
and `scripts/checks/check_realm_tenant_clients.py`.

The old value was not merely outdated, it was inert: realm role `admin` has **zero
holders**. Leaving it would mean the next rebuild silently reinstating a binding that can
authorise nobody.

**Not changed, and not claimed:** nothing was deployed. There is no live `admin-sso` role,
so there is no OIDC login to prove and none is asserted. This is the value the **next**
successful `setup-oidc` will write. Stage 2b is **not done**, and a reader finding
`platform-admin` in `vault.sh` must not conclude otherwise — `vault.sh` carries a comment
pointing here for that reason.

## What has to happen before Stage 2b can be finished

1. **Jon decides** between the config-flag attempt above and a second reinitialise. The
   flag is cheap, reversible and might fail; the reinitialise is known to work, destroys
   the barrier, and mints new AppRole credentials that need their own commit.
2. Whichever path, run `setup-oidc` **before** `bootstrap-approles`. #645's
   `assert_safe_to_revoke` now enforces this rather than merely advising it, so a repeat
   of #643 requires an explicit `ALLOW_REVOKE_WITHOUT_OIDC=1`.
3. Prove it with a **real authorization-code login** for `jon` yielding
   `policy-oidc-admin`. Reading `bao read auth/oidc/role/admin-sso` is not proof; it is
   the config that was already believed correct for the six days the role could authorise
   nobody.
4. **Re-confirm AppRole separately afterwards.** OIDC and AppRole are independent auth
   methods and proving one says nothing about the other — the four rows in Fact 4 are the
   baseline to re-measure against.

## Baseline

`Verified 2026-08-02` after every step, and unchanged throughout — no step here modified
anything:

**16 platform containers by name, 0 unhealthy** — `alertmanager blackbox-exporter cadvisor
grafana keycloak loki minio node-exporter openbao portainer postgres postgres-exporter
prometheus promtail tempo traefik`. The tenant's 7 (`app-ai app-api app-docker-proxy
app-knowledge app-litellm app-mcp app-ui`) alongside, for 23 in total.

OpenBao itself is `Initialized true / Sealed false`, version 2.6.1. **It is healthy. It is
also unadministrable, and health checks cannot tell the difference** — which is the whole
reason this failure mode keeps going unnoticed.
