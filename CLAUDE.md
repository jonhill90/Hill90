# Hill90 — agent orientation

*(`AGENTS.md` and `CLAUDE.md` are the same file — one is a symlink, so there is
no second copy to drift.)*

Read this first. It is deliberately short; follow the links only when you need
them.

**What this is:** the homelab infrastructure for a single VPS — Traefik at the
edge, Keycloak for identity, Postgres, OpenBao, the LGTM observability stack,
Tailscale for private access, and Ansible plus GitHub Actions to rebuild it from
nothing. It is a **platform**: it hosts tenants but is not the application.
[hill90-app](https://github.com/jonhill90/hill90-app) is its first tenant.

## Where to look

- [`docs/runbooks/`](docs/runbooks/) — the operational procedures. Start with
  [`deployment.md`](docs/runbooks/deployment.md); [`vps-rebuild.md`](docs/runbooks/vps-rebuild.md)
  and [`disaster-recovery.md`](docs/runbooks/disaster-recovery.md) are the ones
  you hope not to need.
- [`docs/reference/`](docs/reference/) — the flag-level detail behind those
  procedures.
- [`docs/architecture/`](docs/architecture/) — how the pieces fit, plus
  [`certificates.md`](docs/architecture/certificates.md), which is the recovery
  path if ACME goes wrong.
- [`docs/decisions/`](docs/decisions/) — why things are the way they are.
  [`app-tenancy-on-the-vps.md`](docs/decisions/app-tenancy-on-the-vps.md) defines
  what this platform offers a tenant;
  [`tenant-checkout-hazard.md`](docs/decisions/tenant-checkout-hazard.md) records
  why the tenant needs its own checkout guard and why its risk is the smaller one.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — conventions and the deploy rules.
- Published pages: [docs.hill90.com](https://docs.hill90.com).

## Layout

```
deploy/compose/prod/    the platform stacks — infra, db, auth, vault, observability
platform/edge/          Traefik static template + dynamic middlewares
platform/auth/          Keycloak realm and theme
platform/observability/ Prometheus, Loki, Tempo, Grafana, exporters
infra/secrets/          SOPS-encrypted stores; age private keys are gitignored
scripts/                deploy.sh, backup.sh, _common.sh, checks/
ansible/                VPS bootstrap
docs/                   runbooks, reference, architecture, decisions
```

## Invariants — do not break these without an explicit decision

1. **Merging can deploy to production.** `.github/workflows/deploy.yml` triggers
   on push to `main` under `platform/auth/keycloak/**`,
   `platform/data/postgres/**`, `platform/observability/**` and four
   `deploy/compose/prod/*.yml` files. Check whether a PR touches a filtered path
   *before* merging it. `docs/**` is not filtered.
2. **`--remove-orphans` is banned globally**, in every script and workflow, and
   CI enforces it. It will delete containers belonging to another stack that
   shares a Compose project name.
3. **Production Traefik sets no provider `constraints`.** Every container on the
   socket with `traefik.enable=true` and a `Host` rule is live on the public
   internet the moment it starts. There is no staging state. Bring services up
   one at a time.
4. **`ACME_CA_SERVER` has no default.** `scripts/render-traefik-config.sh`
   refuses to render without it, and `ACME_REQUIRE_PRODUCTION=1` guards the
   opposite mistake. Switching CAs means Traefik will not reissue certificates it
   considers valid, so returning to production requires clearing the ACME
   stores — and `acme-dns.json` holds all four DNS-01 certificates in one file.
   Read [`docs/architecture/certificates.md`](docs/architecture/certificates.md)
   first.
5. **This repo owns the shared networks.** `docker-compose.infra.yml` and
   `scripts/deploy.sh` create `hill90_edge`, `hill90_internal` and
   `hill90_agent_internal`. Tenants consume them as `external: true` and must
   never create them. Renaming or removing one breaks every tenant silently.
6. **Readiness checks run a real query, not a liveness probe.** `pg_isready`
   exits 0 on a Postgres whose credentials are entirely broken; the db check runs
   `psql -tAc "SELECT 1"` as the real user for exactly that reason. Do not
   "simplify" it back.
7. **Secrets come from SOPS or OpenBao, never from a file in the tree.** Age
   private keys are gitignored; only `.pub` files are committed.

## Ground rules for changing this repo

- **Verify against the host, then date the claim.** Anything perishable —
  container counts, health, what a tenant is running — carries a
  `Verified <UTC timestamp>`. A dated claim that has aged is honest; an undated
  one is just wrong later.
- **Do not document what you have not run.** A compose file that parses is not a
  service that starts.
- A tenant's problems are not automatically this repo's problems. The contract
  this platform offers is narrow and written down in
  [`docs/decisions/app-tenancy-on-the-vps.md`](docs/decisions/app-tenancy-on-the-vps.md);
  widening it is a decision, not a fix.

## The governing principle

**The platform provides identity, data and storage. Tenants consume them.**
Every consolidation decision follows from it. Check a new question against this
before treating it as open.

## Settled decisions — do not reopen these

**Keycloak: one Keycloak, one realm, the existing `platform` — and it is LIVE, not
just decided.** `Verified 2026-07-30 02:07 UTC.` hill90-app authenticates against
realm `platform`. Clients `hill90-ui` and `hill90-api` exist there; `hill90-vault`,
`grafana` and `portainer` were untouched. **A human has completed a sign-in** — not
a form rendering. Audience validation landed with the same change. The reasoning was
an Entra analogy — you do not create a second tenant for one organisation; one
directory, controlled with roles and groups. An earlier version of this file said
*"one Keycloak does not mean one realm"*; that was wrong.

**The realm-role collision is resolved in fact, and that is now evidence rather
than design intent.** It was the whole justification for choosing client roles, so
state it plainly: in realm `platform`, the realm role `admin` exists and **has zero
holders**, as do `user`, `editor` and `viewer`. `jon`, `hill90admin` and
`testuser01` hold only `default-roles-platform` as a realm role. Their app
permissions are client roles — `jon` = `hill90-ui:admin,user`, `hill90admin` =
`hill90-ui:admin`, `testuser01` = `hill90-ui:user`. **The Grafana Admin and OpenBao
grant that hangs off the realm `admin` role is therefore unreachable by any app
user.** Measured, not asserted.

> **Two caveats that the good news must not bury.**
>
> **The direct browser bearer call fails on CORS, not on auth.** `api.hill90.com`
> does not allow the `hill90.com` origin. The UI proxies server-side so this is not
> a defect in the running system — but be exact about provenance: proofs 3 to 5 were
> made **with `curl`, not from the page**.
>
> **Open defect: `sess.roles` returned `null`** on a second login while the token's
> own claims were correct. Authorisation is enforced in the api from the token, so
> nothing is unsafe, but a UI reading `session.roles` would render an
> empty-permissions view. Possibly related: `app-ui` logs four
> `[profile-proxy] Error: SyntaxError: Unexpected end of JSON input` failures —
> `JSON.parse` on an empty body — `Verified 2026-07-30 02:07 UTC`. Not proven to be
> the same fault; recorded as the leading candidate.

**Postgres: `app-postgres` goes.** The app consumes the platform's Postgres. The
complication is real and is not the Keycloak steps repeated: this platform's
health check asserts *platform-only databases*, so that boundary has to be
revisited deliberately rather than worked around.

> **That boundary was revisited, and this platform now HOSTS the tenant's
> databases.** `Verified 2026-07-30 01:35 UTC.` Role `hill90_app` (`NOSUPERUSER`)
> owns `hill90_akm`, `hill90_api` and `hill90_litellm`; `hill90`, `keycloak`,
> `postgres` and the templates stay with the platform role. `keycloak`, `grafana`
> and `postgres` all stayed healthy through the `REVOKE` work. The credential is in
> SOPS as `HILL90_APP_DB_PASSWORD`. The local check now asserts **tenant
> isolation** — an application database owned by the platform role still fails, by
> name — and it was only ever a *local dev* check, never production enforcement.
> See
> [tenant-databases-on-platform-postgres.md](docs/decisions/tenant-databases-on-platform-postgres.md).
>
> **The app has NOT been cut over.** It still reads and writes `app-postgres`. The
> databases on this platform are empty and waiting. The change set that repoints it
> is written and **not applied** —
> [app-postgres-cutover-plan.md](docs/decisions/app-postgres-cutover-plan.md).

**This is greenfield, not a migration — with one qualifier that matters.**
hill90-app reached the VPS for the first time on 2026-07-29. Export, import,
rollback and cutover are the wrong frame; the realm export and database backup are
a safety net, not steps in a process.

The qualifier: **"greenfield" does not mean "empty", and the difference was
checked rather than assumed.** `Verified 2026-07-30 01:54 UTC` on `app-postgres`:
`hill90_akm` holds 12 rows and `hill90_litellm` 77, all migration bookkeeping, and
the app's own `hill90` database has no tables at all. But **`hill90_api` holds 105
rows** — `schema_migrations` 65, `tools` 15, `skills` 9, `skill_tools` 7,
`model_catalog` 5, `container_profiles` 3, `model_policies` 1. Catalogue and
bookkeeping; no agents, no chats, no user records. Nothing to preserve — every row
is created by a migration and every `created_at` falls inside the 960 ms window of
the migration run — but say "nothing worth preserving", not "empty".

## Still not done — do not let these read as finished

- **`app-keycloak` and realm `hill90` are still running.** One realm is live on the
  platform, but nothing has been retired. Accounts now exist in *both* places: `jon`,
  `hill90admin` and `testuser01` in platform realm `platform`, and the same three in
  realm `hill90` on the tenant's own Keycloak.
- **`app-postgres` is still running and still serving.** See above.
- **Local is half-drifted**, and is being fixed in the tenant's lane. **Local parity
  lands before anything is retired.**
- **Keycloak event storage is off** — `events_enabled=false` on both `master` and
  `platform`, `Verified 2026-07-30 02:07 UTC`. That is why "has anyone actually
  logged in?" cannot be answered from the host: sessions live in Infinispan, not the
  database, and `event_entity` is empty because nothing writes to it. An empty
  `event_entity` is **not** evidence that nobody logged in. Turning login events on
  would make the estate's most-repeated question checkable instead of anecdotal.

## Genuinely open

**MinIO, and the state is reversed from the other two.** Only `app-minio` exists;
there is **no platform MinIO**. So the question is whether storage moves *up* into
the platform, which the governing principle suggests it should. Never addressed.

## Fast facts

```bash
bash scripts/deploy.sh <infra|db|auth|vault|observability> prod
bash scripts/deploy.sh verify <service> prod
gh workflow run deploy.yml -f service=all
```

- Platform baseline is **13 containers, 0 unhealthy**. A tenant's containers sit
  alongside them and are not part of that count. **Verify the baseline after any
  tenant action — a degraded baseline is the stop-everything signal.** The
  tenancy contract has been tested in both directions: on 2026-07-29 the tenant
  was torn down to a single container and redeployed, and this platform held at
  exactly 13 with all shared networks intact throughout.
- Public: `hill90.com` (the tenant's UI), `auth.hill90.com` (this platform's
  Keycloak, realm `platform`). Tailscale-only: `traefik`, `portainer`,
  `grafana`, `vault`.
- `app-auth.hill90.com` is the **tenant's** Keycloak, not this one. It is **still
  running**, but the app no longer authenticates against it: sign-in now goes to
  `auth.hill90.com`, realm `platform`, on this platform's Keycloak. Retiring
  `app-auth` is pending local parity, not done.
- The deploy user on the VPS is `deploy`; the checkout is `/opt/hill90/app`.
  `/opt/hill90-app` is the tenant's, despite the similar name.
