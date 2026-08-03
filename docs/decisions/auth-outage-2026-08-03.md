# The auth outage of 2026-08-03: empty is not success, and a warning is not a stop

`Written 2026-08-03, after service was restored and proven.`

**All SSO was down for approximately 55 minutes** — `auth.hill90.com` returned 404 while
Keycloak crash-looped. `hill90.com` kept returning 200, which was the UI shell and not
evidence of anything.

## Duration, stated honestly

| Moment | Time (UTC) | How it is known |
|---|---|---|
| #649 merged | **04:22:31** | GitHub merge timestamp |
| `deploy.yml` triggered on the merge | **04:22:33** | workflow run 30784252783 |
| Keycloak first failed to boot | **≈04:23** | **inferred**, not read: that run's step log is no longer retrievable. At 04:39 the container showed 25 restarts, and Keycloak's backoff over 16 minutes is consistent with a first failure right after the deploy recreated it |
| Keycloak started successfully | **05:17:21** | container `StartedAt`, exact |
| Healthy, realm serving, login proven | **≈05:18** | deploy run 30786724444 + a real login |

**≈55 minutes.** The start is the one soft number and it is marked as inferred; the end is
exact.

## What triggered it — and it was my change

`deploy.yml` triggers on push to `main` under `platform/auth/keycloak/**`. **PR #649
modified `platform/auth/keycloak/platform-realm.json`** (correcting an OIDC redirect URI),
so merging it deployed `auth` automatically. That deploy exposed a latent fault and left
Keycloak unable to boot.

CLAUDE.md's first invariant says *"Check whether a PR touches a filtered path before merging
it."* That check was not done. **The fault was latent and pre-existing; the trigger was
mine.**

## The fault, in three layers

Each layer alone was survivable. Together they shipped a blank credential to the identity
provider and reported success.

### Layer 1 — the vault held nothing for `auth`, and never had

The `auth` service declares `secret/shared/database` and `secret/auth/config`. Neither
exists. Enumerated with root:

```
KV paths in the vault:  secret/infra/traefik, secret/infra/vps, secret/observability/grafana
```

`vault.sh cmd_seed` writes exactly those three. It has **never** written the auth paths — so
this is not a #643 regression, it is a permanent gap the rebuild made visible.

Worse, the roles cannot read them anyway:

```
policies that EXIST:      default, policy-admin, policy-infra,
                          policy-observability, policy-oidc-admin, policy-sync, root
AppRole -> policy:        db -> [policy-db]      auth -> [policy-auth]
                          infra -> [policy-infra]  observability -> [policy-observability]
```

**`policy-db` and `policy-auth` do not exist.** `cmd_setup` attaches `policy-<svc>`
unconditionally, while `cmd_policy_apply` only writes the `.hcl` files present in
`platform/vault/policies/` — and there is no `policy-auth.hcl` or `policy-db.hcl`. Both
roles therefore hold a non-existent policy and are denied everything.

**`db` is in exactly the same state**, which means a `db` deploy would have shipped empty
database credentials the same way. Found by audit, not by outage.

### Layer 2 — the failure was silent

`vault_read_kv` sent stderr to `/dev/null` and piped into python, and **python exits 0 after
printing nothing when its input is empty**. A 403, an absent path and a real secret were
indistinguishable. `vault_load_secrets` exported nothing and returned success, so the SOPS
fallback — which exists in both deploy paths — was never reached, because nothing had
failed.

The generic service path also had no empty-value guard. The infra path had one, for
`TRAEFIK_ADMIN_PASSWORD_HASH` only: the lesson had been learned once, for one variable, in
one branch.

Fixed in #651: reads fail loudly, and **any** empty value refuses the load, whatever it is
called.

### Layer 3 — the fix reported and did not stop

#651 was necessary and not sufficient. With `vault_load_secrets` correctly returning 1, auth
deployed **again** with all six variables blank.

**`set -e` is suppressed inside a compound command on the left of `||`.** The vault branch is
exactly `( ... ) || { warn; _deploy_with_sops; }`, so a bare call returning non-zero does not
stop the subshell — it warns and carries on to `docker compose` with nothing loaded:

```
set -e; f(){ return 1; }
( f; echo REACHED ) || echo FALLBACK        -> REACHED    (fallback never runs)
( f || exit 1; echo REACHED ) || echo FALL  -> FALLBACK
```

`exit` is not subject to the suppression; `return` is. Fixed in #652 at both call sites,
with a test asserting every call site aborts explicitly.

## Why nobody's sweep caught it

**A crash-looping container is invisible to both instruments this estate uses.** It is
*present by name*, so the name sweep passes. It reports *no health status at all*, because
the healthcheck never runs, so `--filter health=unhealthy` does not match it either. The
baseline check reported "BASELINE INTACT" throughout.

`scripts/checks/platform-baseline-test.sh` now also fails on
`docker ps --filter status=restarting`. **16 by name, 0 unhealthy, 0 restarting.**

## The ordering trap in the log

`keycloak.sh apply` failed with *"Could not authenticate to Keycloak"*. That is a **downstream
symptom** of the container restarting, not a cause. It resolves itself once Keycloak boots and
is not worth chasing.

## Also found and fixed

`backup.sh backup auth` died with *"Unknown service for backup: auth"* — warned, continued.
The pre-deploy safety net for the **identity provider** silently did nothing. `auth` has no
volume: Keycloak's state is in the platform Postgres, so the pre-deploy backup now targets
`db`.

## SOPS versus vault — names only, no values

```
SOPS key names : 75
vault key names:  6   (across 3 KV paths)

in vault AND in SOPS:  ACME_CA_SERVER, ACME_EMAIL, CF_DNS_API_TOKEN,
                       GRAFANA_ADMIN_PASSWORD, HOSTINGER_API_KEY,
                       TRAEFIK_ADMIN_PASSWORD_HASH
in vault, NOT in SOPS: (none — every vault value has a SOPS source)
```

**SOPS remains the operative store**; the vault holds a six-value subset and nothing that
would be unrecoverable if it were lost. That was the finding #643 needed and it still holds.

What the auth and db stacks need:

| Key | SOPS | vault |
|---|---|---|
| `KC_ADMIN_USERNAME` / `KC_ADMIN_PASSWORD` | yes | no |
| `VAULT_OIDC_CLIENT_SECRET` | yes | no |
| `DB_USER` / `DB_PASSWORD` | yes | no |
| `HILL90_UI_CLIENT_SECRET` | **no** | no |

**`HILL90_UI_CLIENT_SECRET` is absent from both, and that is deliberate** — CLAUDE.md records
it, and `check_env_surface.py` refuses it a default on purpose, because a fallback would
import a *known* secret for the client fronting `hill90.com`. It only bites on a **first**
realm import; the live realm already has the client. It is the one variable still warning in
a successful auth deploy, and that warning is expected.

`VAULT_OIDC_CLIENT_SECRET` was reported as unset during the outage only because **no**
environment was loaded at all. It resolves correctly from SOPS now.

## The decision this leaves open

`vault_paths_for_service` declares paths for `auth` and `db` that cannot work. Two honest
options, and this is a decision rather than a fix:

1. **Add `policy-auth.hcl` and `policy-db.hcl`, extend `cmd_seed`** to write
   `secret/auth/config` and `secret/shared/database`. Vault-first then works for all four.
   It also puts the Keycloak admin credential and the database password into a second store.
2. **Stop declaring those paths** and let auth and db be SOPS-only, which is what they have
   always actually been.

**Not chosen here.** Service is restored, the failure is now loud, and moving credentials
into a new store during an incident is how incidents get longer. `scripts/checks/vault-approle-paths-test.sh`
makes the gap visible until it is decided.

## What proves it is over

- Keycloak `running / healthy / 0 restarts`.
- `auth.hill90.com/realms/platform` returns the realm; discovery document 200.
- **A real authorization-code login for `jon`** yields `policy-oidc-admin` —
  `scripts/checks/vault-oidc-login-test.sh`, not a green workflow.
- All four AppRoles authenticate.
- Baseline **16 by name, 0 unhealthy, 0 restarting**.

Root was minted once through `vault-regain-root.yml` to enumerate the vault, and **revoked**:
`✓ Root token revoked and confirmed dead`, file removed, `sys/generate-root/attempt` back to
**405**, and both OIDC and AppRole still working with no root token anywhere.
