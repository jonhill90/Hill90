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
- [`docs/decisions/2026-07-31-handoff.md`](docs/decisions/2026-07-31-handoff.md) — **start
  here if you are cold.** Where the estate stands, what is verified versus not checked, the
  negative results, and the open decisions.
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
platform/observability/ Prometheus, Alertmanager, blackbox, Loki, Tempo, Grafana, exporters
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
> `postgres` and the templates stay with the platform role. **That is the complete list
> of databases on this instance — there is no `grafana` database.** The `keycloak`,
> `grafana` and `postgres` **containers** all stayed healthy through the `REVOKE` work;
> naming them straight after a list of databases has already caused `grafana` to be read
> as one. Grafana keeps its state in SQLite in the `grafana-data` volume, so a Postgres
> restore does not bring Grafana back — see
> [disaster-recovery.md](docs/runbooks/disaster-recovery.md). The credential is in
> SOPS as `HILL90_APP_DB_PASSWORD`. The local check now asserts **tenant
> isolation** — an application database owned by the platform role still fails, by
> name — and it was only ever a *local dev* check, never production enforcement.
> See
> [tenant-databases-on-platform-postgres.md](docs/decisions/tenant-databases-on-platform-postgres.md).
>
> **The cutover HAPPENED on 2026-07-31, and this paragraph said the opposite until
> it was checked.** It read *"The app has NOT been cut over. It still reads and writes
> `app-postgres`. The databases on this platform are empty and waiting."* All three
> clauses are now false, and the section immediately below already recorded the
> retirement — so this file contradicted itself.
>
> `Verified 2026-07-31 12:05 UTC` on the host: `app-api`'s `DATABASE_URL` is
> `postgresql://hill90_app:…@postgres:5432/hill90_api` — this platform's Postgres,
> which the container resolves to `172.19.0.9` — and **no `app-postgres` container
> exists at all**, not even stopped. The instance holds `hill90`, `hill90_akm`,
> `hill90_api` and `hill90_litellm`.
>
> [app-postgres-cutover-plan.md](docs/decisions/app-postgres-cutover-plan.md) is
> therefore a record of a plan that was carried out, not of pending work.

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

- **Both are now retired — this section previously said they were not.** `app-keycloak`
  went on 2026-07-30 and `app-postgres` on 2026-07-31. Realm `hill90` is gone from the
  live directory, which now holds `master, platform` only. Their data was kept: a realm
  export with users, a per-table-verified dump of all five databases, and the volume
  `prod_app-postgres-data`. See
  [2026-07-31-handoff.md](docs/decisions/2026-07-31-handoff.md) for what remains of each
  and where. `Verified 2026-07-31 06:21 UTC`.
- **Declaring a client in `platform-realm.json` does NOT put it in a realm that
  already exists.** `start --import-realm` is `IGNORE_EXISTING`, so the file is read
  only on first boot — `keycloak.sh`'s own header says so, and #584 shipped clients
  into it with no reconcile path, which made the change inert on production and on
  every existing local stack. Use `bash scripts/keycloak.sh tenant-clients`; it is
  idempotent and **never rewrites an existing client's secret**, because production's
  `hill90-ui` secret is live and correct while `HILL90_UI_CLIENT_SECRET` has no
  production value.
- **A local dev account needs `email`, `firstName` and `lastName`.** The realm carries
  Keycloak's default Verify Profile action, so a user without them is diverted to
  `required-action?execution=VERIFY_PROFILE` and the login never completes. It looks
  like rejected credentials and is not.
- **Local parity — this platform's half is done; the tenant's is not.**
  `platform-realm.json` now carries `hill90-ui` and `hill90-api`, mirroring
  production literally, so a **local** platform Keycloak can serve a tenant the way
  production's does. Proven by importing the realm into a real Keycloak and reading
  the token a user would get: `resource_access.hill90-ui.roles = ['admin']`,
  `aud` includes `hill90-api`, and no `realm_roles` claim —
  `scripts/checks/realm-tenant-serves-test.sh`, `Verified 2026-07-30 02:41 UTC`.
  A **completed authorization-code login** against the running local platform
  Keycloak now backs that up — form, credentials, code, token exchange — with the
  token carrying `resource_access.hill90-ui.roles = ['admin']`, `aud` including
  `hill90-api`, no `admin` in `realm_access.roles`, and a roleless user refused:
  `scripts/checks/tenant-login-local-test.sh`, `Verified 2026-07-30 03:17 UTC`.
  **What remains is the tenant's side:** its local stack still points at its own
  `app-keycloak`, so local proves the realm design and not yet the tenancy.
  **Local parity lands before anything is retired**, because a broken local stack
  would otherwise have nothing to fall back to.
- **`HILL90_UI_CLIENT_SECRET` has no production value in the store yet.** It only
  bites on a FIRST import — the live realm already has the client — so a **VPS
  rebuild** is the case that depends on it, and it must equal the value hill90-app
  holds. `check_env_surface.py` deliberately allows it no default: a fallback would
  import a *known* secret for the client fronting hill90.com and say nothing.
- **Keycloak event storage is now ON** — `events_enabled=true` on both `master` and
  `platform`, `Verified 2026-07-31 06:21 UTC`, reversing the gap this entry used to
  record. "Has anyone actually logged in?" is answerable from the database **for logins
  from here on**. It says nothing about earlier ones: an empty `event_entity` for a past
  date is still **not** evidence that nobody logged in, because nothing was writing to it
  then.

## Genuinely open

**MinIO is settled and shipped — this entry used to say it was never addressed.** A
platform MinIO runs (`Verified 2026-07-31 06:21 UTC`, healthy) and the tenant was cut over
to it; storage moved *up*, as the governing principle indicated. `app-minio` was stopped
2026-07-31 01:40:43 UTC and is **not yet removed**: its retention window expires
**2026-08-01 01:41 UTC**, and deleting `prod_app-minio-data` is a separate, irreversible
decision.

**What is genuinely open now is Jon's, not a lane's** — repository visibility for
hill90-app with the history-rewrite costs, whether the tenant's local stack moves onto the
platform services, and a reboot to validate the vault auto-unseal path. All of them are
stated with their evidence in
[2026-07-31-handoff.md](docs/decisions/2026-07-31-handoff.md).

## Fast facts

```bash
bash scripts/deploy.sh <infra|db|auth|vault|observability> prod
bash scripts/deploy.sh verify <service> prod
gh workflow run deploy.yml -f service=all
```

- **Alerts reach a human, as of 2026-07-31.** 16 rules, 8 groups, delivered by
  Alertmanager over email to `ACME_EMAIL` via the SMTP account the estate already
  had. Delivery is proven end to end, not assumed. Before that date there was **no
  receiver at all** and every rule was inert — `ServiceDown` fired for ≥48 hours in
  the week to 2026-07-26 and reached nobody. Start at
  [`docs/decisions/alerting-audit.md`](docs/decisions/alerting-audit.md).
- **Before reporting "none", "empty" or "never", check the instrument first.** An
  instrument that cannot see the thing looks exactly like the thing being absent —
  six times on 2026-07-31, including a missing `strings` binary read as an empty
  log and a green `amtool check-config` on a config that could not deliver. The
  practice, the six cases and the positive-control defence:
  [`CONTRIBUTING.md`](CONTRIBUTING.md#verify-the-instrument-before-you-believe-the-verdict).
- **Two traps that have each cost a session. Do not re-derive them.**
  **cAdvisor emits zero Docker container series on this host** — 45 cgroup and
  systemd series, `count(container_memory_usage_bytes{name!=""})` is 0 — so any
  plan starting "cAdvisor already scrapes the containers" is starting from a false
  premise. And **a rule can be `health=ok` and still be unable to fire**, if it
  matches a label production never emits; two shipped that way. `promtool test` cannot
  catch it because the test author supplies the labels — run
  `python3 scripts/checks/check_alert_series.py` **on the VPS**, which asks the live
  Prometheus.
- Platform baseline is **16 containers by name, 0 unhealthy** —
  `Verified 2026-07-31 09:58 UTC`, after #617 deployed `alertmanager` and
  `blackbox-exporter`. With the tenant's 7 that is **23 running in total**.
  The full 16: `alertmanager blackbox-exporter cadvisor grafana keycloak loki
  minio node-exporter openbao portainer postgres postgres-exporter prometheus
  promtail tempo traefik`.
  **Count by that list, not from memory.** The old shorthand was "13 by name plus
  minio", so 13 + 2 new = 15 is a natural and wrong arithmetic — minio was never
  inside the 13. And match on `blackbox-exporter`, not `blackbox`: an exact-match
  sweep for the short name reports it missing when it is running.
  A tenant's containers sit
  alongside them and are not part of that count. **Verify the baseline after any
  tenant action — a degraded baseline is the stop-everything signal.** The
  tenancy contract has been tested in both directions: on 2026-07-29 the tenant
  was torn down to a single container and redeployed, and this platform held at
  exactly 13 with all shared networks intact throughout.
- Public: `hill90.com` (the tenant's UI), `auth.hill90.com` (this platform's
  Keycloak, realm `platform`). Tailscale-only: `traefik`, `portainer`,
  `grafana`, `vault`.
- `app-auth.hill90.com` is the **tenant's** Keycloak, not this one, and it is
  **gone**. `Verified 2026-07-31 12:05 UTC`: no `app-keycloak` container exists and
  the hostname returns **404**. This entry said *"It is still running … retiring
  `app-auth` is pending local parity, not done"* — false since 2026-07-30, and
  contradicted by the retirement recorded earlier in this file. Sign-in goes to
  `auth.hill90.com`, realm `platform`, on this platform's Keycloak.
- The deploy user on the VPS is `deploy`; the checkout is `/opt/hill90/app`.
  `/opt/hill90-app` is the tenant's, despite the similar name.
