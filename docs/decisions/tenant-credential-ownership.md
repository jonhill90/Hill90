# Who owns a tenant's credential to a platform-owned object

**Status:** decided, recorded 2026-07-30. Generalises a rule that had been settled
twice in a row, once per credential, without being written down as a rule.

**Relates to:**
[app-tenancy-on-the-vps.md](app-tenancy-on-the-vps.md) (the tenancy contract),
[tenant-databases-on-platform-postgres.md](tenant-databases-on-platform-postgres.md)
(where the same question was answered for the database role)

## The rule

**When the platform owns the object, the platform's store owns the credential to
it, and the tenant holds a replica.**

A tenant's database role lives in the platform's Postgres. A tenant's OIDC client
lives in the platform's Keycloak realm. In both cases the object is the platform's,
so `infra/secrets/prod.enc.env` in *this* repository is authoritative and the
tenant's own store holds a copy that it consumes.

| Credential | Object it opens | Authoritative store | Tenant's key |
|---|---|---|---|
| `HILL90_APP_DB_PASSWORD` | role `hill90_app` in the platform Postgres | Hill90 | `PLATFORM_DB_PASSWORD` (planned) |
| `HILL90_UI_CLIENT_SECRET` | client `hill90-ui` in realm `platform` | Hill90 | `AUTH_KEYCLOAK_SECRET` |

## Why not the tenant

The tenant would own the credential to a client in **someone else's realm**, and
this platform could not rebuild the VPS without reaching into the tenant's secret
store. That inverts the tenancy contract: the whole point of
[app-tenancy-on-the-vps.md](app-tenancy-on-the-vps.md) is that the platform's
obligations are narrow, explicit, and satisfiable without knowing anything about a
particular tenant. A rebuild path that depends on a tenant's private store is not
satisfiable by this repository alone.

That is the reason, not a preference for symmetry.

## Why not "Keycloak is the only source"

There is a genuinely good competing option, and it was not dismissed lightly:
**let Keycloak mint the client secret and have the tenant fetch it** with
`bash scripts/keycloak.sh client-secret hill90-ui`. Nothing extra is stored, and
every additional copy of a secret is a drift opportunity — the drift that cost this
estate a night when the `hill90-ui` secret in the store and the one in Keycloak
disagreed.

Note the asymmetry that makes it tempting here but not for the database: for a
database role, this platform **must** know the password because it sets it with
`CREATE ROLE … PASSWORD`. For an OIDC client, Keycloak can generate the secret
itself, and there is already a first-class read path. So storing it here adds a copy
without adding capability.

**It loses on disaster recovery, decisively.** Hill90's SOPS store exists so the VPS
can be rebuilt from nothing. Under "Keycloak is the only source", a rebuild mints a
*fresh* secret; the tenant's stored value is stale the instant the realm imports, and
login is broken until a human re-fetches it and re-encrypts. That turns "restore and
go" into "restore, then debug an `invalid_client`". Under this rule the rebuild
restores the same secret and the tenant keeps working with no action at all.

## The mitigation for two copies

Two stores holding one secret is a real hazard, so name the owner and provide a
reconciliation rather than pretending one copy is enough:

- **Hill90's store is authoritative.** If the two disagree, Hill90's value wins.
- **Reconciling means pushing the authoritative value**, never generating a new one.
  For the database that is re-running `provision-tenant-db.sh`, which resets the role
  password idempotently. For the OIDC client it means writing the stored secret onto
  the client — see the warning below before doing it.

## Two hazards, both specific to filling `HILL90_UI_CLIENT_SECRET`

`Verified 2026-07-30 03:31 UTC:` the key is **absent** from
`infra/secrets/prod.enc.env` — not empty, not a placeholder, not present. The live
realm holds a working secret and `hill90-app` holds the match; that pair is what
makes login work today.

**1. A freshly generated value would be a landmine with a long fuse.** Whatever is
written into this store must *equal* the live secret. A new random value changes
nothing immediately — and then breaks login at the next realm import, which may be
months later during a rebuild, with nothing connecting cause to effect.

**2. "Reconciling" by writing onto the live client breaks login immediately.** The
tenant holds the current value; overwriting the client's secret invalidates it at
once. This is why `keycloak.sh tenant-clients` **never rewrites an existing client's
secret** — absent client, secret required; present client, credentials untouched.

The safe order is: read the live value, write it into this store, verify by hash
against the tenant's copy, change nothing live.

## The gap that remains, and it fails open

`platform-realm.json` declares `"secret": "${HILL90_UI_CLIENT_SECRET}"`. **Measured,
not predicted** — importing the real realm file into a throwaway Keycloak with the
variable unset:

```
secret length : 26
is the literal ${HILL90_UI_CLIENT_SECRET}: True
```

Keycloak does not error and does not generate a random secret. It stores the
**literal string** `${HILL90_UI_CLIENT_SECRET}` as the client secret. So a rebuild
performed while this store is missing the key produces two problems, and the second
is worse than the first:

1. The tenant's login fails with `invalid_client` — the exact failure of 2026-07-29.
2. The client secret of the confidential client fronting `hill90.com` becomes a
   **known, guessable string published in a public repository.**

`keycloak.sh tenant-clients` does **not** repair this: the client exists, so it takes
the "present" branch and deliberately leaves the secret alone. The fail-closed design
that protects production is also what stops it fixing this. **Any guard has to sit at
the import path, which is currently unguarded**, and `check_env_surface.py`
deliberately exempts this key from the have-a-default rule — correctly, since a
default would bake a *known* secret into every deploy, but the exemption does nothing
about the unset case at import.

Filling the key removes hazard 1 and 2 together. Adding an import-time guard is worth
doing regardless of which store is authoritative, because failing open and silently is
the property to remove.
