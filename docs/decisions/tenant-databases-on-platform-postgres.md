# Hosting a tenant's databases on the platform's Postgres

**Status:** capability added 2026-07-30, and **provisioned on production the same
day** (see "On the real instance" below). **The tenant has not moved.** The AI app
still runs its own `app-postgres` and still serves from it; nothing here deletes,
migrates or repoints anything. The databases now exist on the platform and are
empty, waiting for the app to be repointed — a separate change in `hill90-app`.

## On the real instance — `Verified 2026-07-30 01:35 UTC`

Provisioned against the production platform Postgres at **01:34:42–01:34:44 UTC**
(read from the data directory's creation times, since Postgres records no database
creation timestamp) with the merged script
(sha256 `e3983b4c…`, checksum-matched on the host before running), `--dry-run`
first. Role `hill90_app`; databases `hill90_api`, `hill90_akm`, `hill90_litellm`.

```
hill90          | owner=hill90      | public_connect=false | acl=hill90=CTc/hill90
hill90_akm      | owner=hill90_app  | public_connect=false | acl=hill90_app=CTc/hill90_app
hill90_api      | owner=hill90_app  | public_connect=false | acl=hill90_app=CTc/hill90_app
hill90_litellm  | owner=hill90_app  | public_connect=false | acl=hill90_app=CTc/hill90_app
keycloak        | owner=hill90      | public_connect=false | acl=hill90=CTc/hill90
postgres        | owner=hill90      | public_connect=false | acl=hill90=CTc/hill90

hill90      | super=true  | createdb=true  | createrole=true
hill90_app  | super=false | createdb=false | createrole=false
```

Both halves proven over the network from a container on `hill90_internal`, not by
`docker exec`. The tenant reached `hill90_api`, `hill90_akm` and `hill90_litellm`;
it was refused on `hill90`, `keycloak`, `postgres` and `template1` with
`FATAL: permission denied for database … User does not have CONNECT privilege.`

**The revokes did not disturb the platform**, and the proof is live consumers
rather than an argument: after them, `keycloak` and `postgres-exporter` were still
connected over the network as `hill90` (`pg_stat_activity` shows `keycloak` from
`172.19.0.12` and `hill90` from `172.19.0.11`), Keycloak still served realms
`master, platform`, and the platform held at 13 containers, 0 unhealthy.

**Correction, 2026-07-31:** this paragraph also cited Grafana returning `200` with
`"database": "ok"` as evidence the revokes were safe. It is not evidence, and citing it
overstated the case. **Grafana does not use this Postgres** — it keeps its state in
SQLite inside the `grafana-data` volume, verified 2026-07-31 (no `grafana` database
exists on the instance; `/var/lib/grafana/grafana.db` is ~1.8 MB). Its health endpoint
was reporting on its own SQLite file and would have said `ok` whatever the ACLs did. The
remaining evidence — live `keycloak` and `postgres-exporter` connections, served realms,
and the container baseline — stands on its own. The reason it is safe is that every
consumer of this Postgres connects as `hill90`, a superuser, and superusers bypass
ACL checks entirely.

The narrowed health check was run against the real database list, and both of its
failure branches were driven there and repaired: opening a tenant database to
`PUBLIC` (caught), and leaving a platform database open to `PUBLIC` while a tenant
exists (caught, then fixed by `--harden-only`). `template0` was used for the
second probe because `datallowconn=false` makes it unconnectable regardless.

### Two name collisions that block a naive repoint

The app's own Postgres holds `hill90`, `hill90_akm`, `hill90_api`,
`hill90_litellm`, `keycloak` and `postgres`. Two of those **cannot be recreated on
the platform under the same names**:

- **`keycloak`** — the app's Keycloak store. The platform's identity database has
  that exact name. This is the volume collision of #4 in a different costume.
  Nothing needs moving if the app stops shipping its own Keycloak, which is the
  settled direction, but it must not be moved as-is.
- **`hill90`** — `POSTGRES_DB` for `app-postgres`, and also the platform's own
  database name.

The provisioner refuses both by name, so the mistake fails loudly rather than
silently mounting the app on top of platform data.

**Relates to:** [platform-primitives.md](platform-primitives.md),
[app-tenancy-on-the-vps.md](app-tenancy-on-the-vps.md)

## The question

Postgres is this platform's counterpart to Azure Database for PostgreSQL. A
managed database service hosts other people's databases — that is the entire
capability. This platform's Postgres could not: it had exactly one login role,
`hill90`, a superuser and the owner of every database, and a local health check
that treated any database it did not recognise as a fault.

So there were two ways to give the app a database on the platform, and both were
wrong:

1. **Give the app the `hill90` role.** It is a superuser. The tenant would have
   read and write access to `keycloak` — every user, credential and session in
   the platform's identity provider — and the ability to drop it.
2. **Have the platform create and own the app's databases.** This is what
   [#495](https://github.com/jonhill90/Hill90/pull/495) deleted Postgres over:
   application databases in the platform bootstrap are what made Postgres look
   like an application dependency in the first place.

## The decision

**A role per tenant, least privilege, and the databases owned by that role.**

- One login role per tenant: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS`.
- The tenant's databases are **owned by the tenant role**, which also owns their
  `public` schema, so the tenant needs no grant from the platform to create its
  own tables.
- `PUBLIC` is revoked on every database — the tenant's and the platform's. This
  is the step that makes the boundary real rather than nominal, and it is easy to
  miss: Postgres grants `CONNECT` to `PUBLIC` on every new database by default,
  so a freshly created tenant role can open `keycloak` on day one without any
  grant at all.
- Provisioning is a **control-plane operation**, `scripts/provision-tenant-db.sh`,
  not a line in the bootstrap. `platform/data/postgres/init.sh` stays
  platform-only, so #495's rule is intact: a database there still means a
  platform service owns it. It also would not have worked — `init.sh` runs only
  on an empty data volume, and production's is not empty.

### Flagged for overrule: how much privilege the tenant gets

**`NOCREATEDB` is a judgement call and it is the one to argue with.** With it, a
tenant cannot create its own databases; every new one is a platform operation and
someone has to run the script. Without it, the tenant self-serves, and the cost is
that it can also create databases nobody asked for on a shared server.

Least privilege was chosen because the alternative to a *narrow* tenant role was
never a *slightly wider* one — it was the `hill90` superuser. If self-service
matters more than the narrow grant, `CREATEDB` is a one-word change to
`ROLE_ATTRS` in the provisioner, and the isolation test asserts the current
behaviour, so flipping it will fail loudly and tell you exactly what you changed.

### Where the tenant's password lives — amended 2026-07-30

**The provisioner still never writes it.** It reads `TENANT_DB_PASSWORD` and
persists nothing: not to disk, not to a store, not to the terminal.

**But the credential is now stored, in this platform's SOPS store, as
`HILL90_APP_DB_PASSWORD`** (`infra/secrets/prod.enc.env`, vault path
`secret/tenants/hill90-app/database`, registered in
`platform/vault/secrets-schema.yaml` with `compose_refs: []` because no platform
compose file consumes it). The tenant needs the credential in order to be
repointed, and a credential that exists only in one operator's terminal is not
operable.

**This creates the two-copies condition the paragraph below warns about, so name
the authority explicitly: this store is authoritative.** The platform sets the
password; when `hill90-app` copies it into its own store, that copy is a replica.
If they ever disagree, the repair is to re-run the provisioner with the value from
*here* — it is idempotent and resets the password, which is the same shape as the
Keycloak client-secret repair.

The original reasoning still stands as the warning it was: two stores holding one
secret is exactly how the app's Keycloak client secret drifted out of agreement
with Keycloak and cost a night of diagnosis. The mitigation is a declared owner and
an idempotent reconciliation command, not pretending one copy is enough.

> **Generalised 2026-07-30.** The same question came up again for the `hill90-ui`
> OIDC client secret and got the same answer for the same reason, so the rule is now
> written down once instead of re-argued per credential:
> [tenant-credential-ownership.md](tenant-credential-ownership.md). Read that before
> deciding where a *third* tenant credential lives — MinIO is the likely next one.

## What broke that had to be fixed alongside

**A least-privilege tenant cannot install extensions.** The app's migrations run
`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` and `CREATE EXTENSION IF NOT EXISTS
vector` (`services/knowledge/app/db/migrations/001`, `011`, `012` in
`hill90-app`). Neither is a trusted extension, so a non-superuser cannot create
either, and the app's first migration would have failed against the platform. It
works today only because the app's `DB_USER` is a superuser in the app's own
Postgres.

The provisioner installs both, so the app's `IF NOT EXISTS` finds them present
and does nothing. This is the same shape as a managed service, where the provider
installs from an allowlist. **It is also a constraint on the app:** any future
extension has to be added to the provisioner, and the failure will surface as a
migration error, not as a permissions message.

## The health check was narrowed, not deleted

`scripts/local.sh` asserted "platform-only databases": anything other than
`postgres`, `keycloak` and the owner's database failed. Correct guard, wrong
condition once tenancy is the point — it fails on the legitimate case.

It now asserts **tenant isolation**, and the fault it used to catch still fails,
by name:

| Condition | Result |
|---|---|
| No tenant databases | pass — "platform databases only" |
| Tenant database owned by an unprivileged role, closed to `PUBLIC` | pass, and it is listed with its owner |
| Application database owned by the platform role | **fail** — named as the #495 drift |
| Tenant database owned by a superuser | **fail** |
| Tenant database granting `CONNECT` to `PUBLIC` | **fail** |
| A tenant exists and a platform database still grants `CONNECT` to `PUBLIC` | **fail**, with the repair command |

Worth being clear about what this check is, because it has been described as a
production boundary: it is a **local development check**. It is not enforcement,
and nothing in the deploy path consults it. `hill90-app`'s `deploy.sh` mentions
platform-only databases in a summary string only.

## Why the tests are shaped the way they are

`docker exec postgres psql -U some_role` **proves nothing about a role's
privileges**. The platform's `pg_hba.conf` is `trust` for local socket and
`127.0.0.1` connections, so an in-container `psql` succeeds with no password, the
wrong password, or for a role whose password was never set. Only a connection
arriving over the container network reaches the `scram-sha-256` line.

So every assertion in `scripts/checks/tenant-db-isolation-test.sh` is made from a
second container over a docker network, and one of them deliberately uses the
wrong password: if that connection ever succeeds, `pg_hba` has been loosened and
every other assertion in the file is worthless.

## Rollback

Nothing here is destructive and nothing runs automatically. To undo the capability
on a given Postgres:

```sql
-- per tenant database
DROP DATABASE hill90_api;               -- only if the tenant is not using it
-- then the role
DROP ROLE hill90_app;
-- and, to restore Postgres' default openness (not recommended)
GRANT CONNECT ON DATABASE keycloak TO PUBLIC;
```

Reverting the code is a plain `git revert`; the narrowed health check goes back to
failing on any non-platform database, which is correct behaviour for a Postgres
with no tenants on it.

## See also

- [app-postgres-cutover-plan.md](app-postgres-cutover-plan.md) — **the app-side
  change set**: every connection string with file and line, the key names, the
  order, the rollback, and a per-database verdict on what happens to the data
- [platform-primitives.md](platform-primitives.md) — why Postgres is a platform
  service and not an application dependency
- [app-tenancy-on-the-vps.md](app-tenancy-on-the-vps.md) — the tenancy contract
- [../runbooks/tenant-app-deployment.md](../runbooks/tenant-app-deployment.md) — the deployment sequence
