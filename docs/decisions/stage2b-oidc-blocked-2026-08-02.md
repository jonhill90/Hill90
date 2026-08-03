# Stage 2b: the vault had no OIDC method — and the door back was not one-way after all

> ## RESOLVED 2026-08-03. Stage 2b is complete.
>
> OIDC is enabled on the production vault, and **a real authorization-code login for `jon`
> yields `policy-oidc-admin`** against the `platform-admin` bound claim. The recovery ran
> through `vault-regain-root.yml`; the unauthenticated root-generation window was opened and
> closed inside that one run, and the root token minted for it has been **revoked and
> removed**. Everything below the line is the investigation that got here and is kept as the
> record; the outcome is in "How it actually ended" at the bottom.
>
> *The filename still says `blocked`. Links to it exist in seven files and in merged commit
> messages, so it stays — the banner is the correction, not a rename.*


`Measured 2026-08-02.` Production was inspected **read-only**; nothing was deployed or
changed there. The recovery was proven on **throwaway OpenBao 2.6.1 instances**, isolated,
never against production.

**Two findings, and the second is the one that matters beyond Stage 2b.**

1. **Stage 2b cannot be completed as things stand.** The production vault has no OIDC auth
   method to repoint, no usable root token, and no AppRole that can create one.
2. **The estate's belief that this is unrecoverable is false, and rests on a broken
   instrument.** Root *can* be regained from the unseal key, without destroying the vault.
   `bao operator generate-root`'s 403 — cited in five documents as proof the door is
   one-way — comes from a **legacy API path**, not from an irreversible state.

## Finding 1 — why Stage 2b is blocked

| Question | Answer | Instrument |
|---|---|---|
| Is the OIDC auth method mounted? | **No** | unauthenticated probe with both controls |
| Is the on-disk root token usable? | **No** — `403 permission denied` | `bao token lookup` |
| Can any AppRole enable it? | **No** — `deny` ×4 | `bao token capabilities sys/auth/oidc` |

#643 rebuilt the vault **before** #645's guard existed, so `bootstrap-approles` ran first
and revoked root on its way out; `setup-oidc` never ran.

**OIDC is not mounted**, and the instrument was controlled before it was believed. With no
token, `bao auth list` is unavailable — which is why this was unanswerable until now. The
probe reads unauthenticated status codes instead:

```
positive control  auth/approle/login                -> 500   (mounted; backend rejected the payload)
negative control  auth/no-such-method-3594870/login -> 403   (absent; no handler)
target            auth/oidc/oidc/auth_url           -> 403   (matches the ABSENT control)
```

**403, not 404, is what OpenBao returns for an absent mount** — counter-intuitive enough
that the reading is worthless without the pair. Shipped as
`scripts/checks/vault-oidc-enabled-test.sh`, which refuses a verdict if either control
misbehaves. A second, independent instrument agrees: the barrier-encrypted auth mount table
`/openbao/file/core/_auth` has mtime `Aug 2 23:48` — the rebuild, untouched since.

**AppRole is healthy** and is not the blocker: `db`, `auth`, `infra` and `observability` all
authenticate, each with its own policy. Now a command rather than a memory:
`scripts/checks/vault-approle-login-test.sh`.

**Keycloak is already correct.** `jon` holds realm role `platform-admin` (#636); client
`hill90-vault` carries mapper `realm-roles` with `claim.name=realm_roles`, the deliberate
non-default. OpenBao is the only thing in the way.

## Finding 2 — the 403 that closed the door was the wrong instrument

Five documents state that root cannot be regenerated on 2.6.1, all tracing to one
observation: `bao operator generate-root -init` returns **403 permission denied**.

**The CLI targets `sys/generate-root-token/*`. That path returns 403 under every
configuration tested — flag or no flag. The live endpoint is `sys/generate-root/*`.**

A/B on throwaway 2.6.1 instances, each initialised, unsealed, and with root revoked and
confirmed dead first — so both arms model production:

| Arm | Config | `POST sys/generate-root/attempt` |
|---|---|---|
| A | production's `config.hcl`, verbatim | **405** |
| C | same + `disable_unauthed_generate_root_endpoints = false` **in the listener stanza** | **200** |
| — | absent-path control, both arms | 403 |

On arm C the recovery completes end to end:

```
attempt started                     nonce + otp returned
unseal key share supplied           complete=true, encoded_token returned
decoded (XOR of encoded and otp)    26-byte token
token lookup                        policies: ['root']
auth enable oidc                    SUCCEEDED
auth/oidc probe                     403 -> 400   (absent -> mounted)
```

### Why this was missed, and the control that proves the placement

**The flag is read only inside `listener`.** At top level it is *accepted and silently
ignored*. The parser is the control:

```
disable_unauthed_generate_root_endpoints = "not-a-bool"   at top level  -> server boots happily
disable_unauthed_generate_root_endpoints = "not-a-bool"   in listener   -> refuses to boot:
    invalid value for disable_unauthed_generate_root_endpoints: cannot parse as bool
```

`vault-unseal.md` recorded the 2026-07-26 attempt as made "with the flag set at listener and
at top level". Given the top-level placement is inert and the CLI 403s regardless, that
attempt could not have succeeded however it was placed — the CLI was the wrong instrument in
both cases. **The prior negative result was honest and wrong.**

### What this does and does not change

**Does not change:** don't revoke root early. Recovery costs a production config change, two
vault restarts, and a window in which anyone reaching the listener with an unseal key share
mints root **with no token at all** — threshold here is 1 of 1. #645's
`assert_safe_to_revoke` stays exactly as it is; it prevents needing any of this.

**Does change:** "the only route back is a reinitialise" is retired. A reinitialise destroys
the barrier and mints new AppRole credentials that need their own commit; root recovery
touches no data. Corrected in `vault-unseal.md`, `vault-vs-sops.md` (twice),
`approle-rejection-2026-08-01.md`, `keycloak-admin-rotation.md`, `openbao-rebuild.md`,
`scripts/vault.sh` and `check_vault_revoke_order.py`.

## What this PR ships

- **`platform/vault/config.recovery.hcl`** — production's config plus the one listener
  parameter. Selected at deploy time through `VAULT_CONFIG_FILE`, which
  `docker-compose.vault.yml` already supports (the mechanism `config.raft.hcl` uses), so
  **merging this file changes nothing by itself.**
- **`scripts/vault.sh regain-root`** — speaks HTTP directly, because the CLI is the
  instrument that reported the door closed. Refuses if the endpoint answers 405 (wrong
  config) and refuses to clobber a token that is still valid. Never prints the token.
  Tested three ways against throwaway vaults: refusal on production config, success on
  recovery config, refusal when a live token exists.
- **`.github/workflows/vault-regain-root.yml`** — opens the window and closes it in **one
  run**: deploy recovery config → assert auto-unseal → mint → `setup-oidc` → deploy
  `config.hcl` → **assert the endpoint answers 405 again** → re-prove AppRole → baseline.
  The run fails if the door is left open. Typed `REGAIN` confirmation; refuses outright if a
  valid root token already exists.
- **`scripts/checks/platform-baseline-test.sh`** — 16 by name, 0 unhealthy, encoding both
  traps CLAUDE.md warns about: count from the list not from memory, and match
  `blackbox-exporter` exactly.
- **`scripts/vault.sh` bound claim** → `platform-admin`, matching Grafana's #637. Claim
  *name* unchanged; #635 measured that binding as already consistent.

## The dead root token file — removed, and why

`/opt/hill90/secrets/openbao-root.token` (0600 `deploy:deploy`, 26 bytes, mtime
`Aug 2 23:48`) held a **revoked** token. `bootstrap-approles` revokes with
`token revoke -self` and never touches the file; only `vault.sh revoke-root` deletes it, and
that never ran. So the host advertised root access it did not have.

Verified dead immediately before removal, with both controls — a known-bad token also reads
dead, and a working AppRole token reads live, so the probe distinguishes the two — then
`shred -u`, and absence confirmed. **`openbao-unseal.key` is untouched**: it is what the
recovery depends on.

It could not be made to hold a live value instead, because minting one requires deploying
the recovery config, and deploys come from `origin/main`.

## Operational note: the host checkout is behind, and the next deploy will halt

`/opt/hill90/app` is at **`c16a4de` (#640)**, five commits behind, and
`infra/secrets/prod.enc.env` shows as modified against it. **It is byte-identical to current
`origin/main`** — #643 did commit the regenerated AppRole credentials — so nothing is at
risk. But `preflight-checkout.sh` refuses a dirty tree, so the **first deploy of any kind
will stop** until someone confirms that. Expected, fail-closed, and better known in advance
than at the top of a recovery run.

## Baseline

`Verified 2026-08-02`, before and after every step, including after removing the token file:
**16 platform containers by name, 0 unhealthy** — `alertmanager blackbox-exporter cadvisor
grafana keycloak loki minio node-exporter openbao portainer postgres postgres-exporter
prometheus promtail tempo traefik` — with the tenant's 7 alongside, 23 in total. OpenBao
`Initialized true / Sealed false`, 2.6.1.

## How it actually ended — `Verified 2026-08-03`

### The recovery ran, and the window shut

`vault-regain-root.yml` (run 30783449270) completed with every step green: baseline → deploy
`config.recovery.hcl` → assert auto-unseal → mint → `setup-oidc` → deploy `config.hcl` →
assert the endpoint is shut → confirm OIDC → re-prove AppRole → baseline.

```
Regain root from the unseal key    ✓ Root regained ... policies: root
ASSERT ... shut again              POST sys/generate-root/attempt -> 405  (405 = closed)
Confirm OIDC survived              positive 500 / negative 403 / target 400  -> MOUNTED
```

**The guard was checked for teeth, not just for green.** Running the workflow's assert logic
verbatim against a throwaway vault that *is* on the recovery config returns 200 and exits 1
with the `::error::`. A passing assertion therefore means something.

Independently confirmed on the host afterwards: the live container mounts
`platform/vault/config.hcl`, that file contains **0** occurrences of the flag, and
`sys/generate-root/attempt` answers **405** while the absent-path control answers 403.

### The login — proven, and proven to gate

```
✓ OpenBao issued an authorize URL for role admin-sso
✓ it points at https://auth.hill90.com, realm platform
✓ Keycloak served a login form
✓ Keycloak issued an authorization code
✓ OpenBao issued a token (value not printed)
✓ policies: default,policy-oidc-admin
```

A positive result alone would not show the binding *gates* anything. Negative control: the
same user, same flow, a throwaway role bound to `a-role-nobody-holds` —

```
{"errors":["OpenBao login failed. error validating claims: claim \"realm_roles\" does not
match any associated bound claim values"]}
```

— refused, explicitly on the claim. The throwaway role was deleted; `bao list auth/oidc/role`
returns `['admin-sso']`.

Shipped as `scripts/checks/vault-oidc-login-test.sh`, re-runnable.

### The defect that made a working system look broken

The first login attempts failed with `{"errors":["permission denied"]}` and **nothing in the
OpenBao log**, which reads exactly like a rejected claim. It was not.

**The API callback is `/v1/auth/oidc/oidc/callback`** — the method is mounted at `oidc` and
the plugin's own route is `oidc/callback`. `setup-oidc` registered
`/v1/auth/oidc/callback`, which is not a route at all, so the request never reached the OIDC
backend and OpenBao denied it generically.

The UI redirect URI was always correct, so **browser logins were never affected** — which is
why this survived undetected. Corrected in `scripts/vault.sh`, `scripts/keycloak.sh`,
`scripts/local.sh` and `platform/auth/keycloak/platform-realm.json`.

Diagnostic worth keeping: `permission denied` **with no OIDC log line** means the path is
wrong; a bound-claim failure names the claim and appears in the response.

### AppRole, independently

Re-proved after all OIDC work and again after the root revoke: `db`, `auth`, `infra`,
`observability` all authenticate with their own policies. This whole episode began with one
auth method silently failing while the other looked fine, so it is measured separately every
time, never inferred.

### Root token: revoked, and the file removed

`vault.sh revoke-root` reported `✓ Root token revoked and confirmed dead` — it verifies by
looking the token up again, because `token revoke -self` exits 0 even for a token that never
existed — then `✓ Removed /opt/hill90/secrets/openbao-root.token`.

**The file is absent, and that is the intended end state.** Confirmed by `ls`. It holds no
value, live or dead, so there is nothing for a future session to mistake for root.
`openbao-unseal.key` is untouched: it is the input to any future recovery.

Proof the estate still works with no root token anywhere: a fresh OIDC login still returns
`policy-oidc-admin`, and all four AppRoles still authenticate.

### Baseline

**16 platform containers by name, 0 unhealthy**, before and after every deploy and after the
revoke, with the tenant's 7 alongside.

## Loose ends, stated rather than left

- **`TEST_USER_PASSWORD` does not authenticate `testuser01`.** Found while looking for a
  negative-control user; the login form returns 200 with no redirect. Store-versus-realm
  drift, the same shape as the `GRAFANA_OIDC_CLIENT_SECRET` finding in #635. Not
  investigated — it blocks nothing and is outside this change.
- **The host checkout was five commits behind with a dirty `prod.enc.env`.** The file was
  byte-identical to `origin/main`, so `git reset --hard` was safe and AppRole was re-proved
  immediately afterwards. `preflight-checkout.sh` would have halted the deploy first, which
  is the guard working.
