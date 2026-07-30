# Pointing hill90-app at the platform's Postgres — the change set

**Status:** plan and change set only, recorded 2026-07-30. **Nothing has been cut
over.** `app-postgres` is running, serving, and untouched; no `hill90-app` file has
been edited. This document exists so the change can be applied in one clean pass
when that lane is free.

**Why it lives in Hill90:** the platform half is here — the tenant role, the
databases, the credential, and the health check that watches the boundary. See
[tenant-databases-on-platform-postgres.md](tenant-databases-on-platform-postgres.md)
for what already exists on the platform side.

**Every line number below was read from the files, and every claim about running
state was verified against the host.** Line numbers drift; re-grep before trusting
them if this document has aged.

---

## 1. The data — verified per database, not inherited

Jon's instruction was to say this explicitly per database rather than assume
"greenfield" carries over from the realm work. It mostly does, but **not
uniformly**, and one database needed real checking.

`Verified 2026-07-30 01:54 UTC against app-postgres on the VPS.`

| Database | Tables | Live rows | Verdict |
|---|---|---|---|
| `hill90_api` | 32 | **105** | Nothing to preserve — **but see below**, this one is not empty |
| `hill90_akm` | 14 | 12 | Nothing. All 12 are `schema_migrations` rows; every user table is 0 |
| `hill90_litellm` | 47 | 77 | Nothing. All 77 are `_prisma_migrations`; every other table is 0 |
| `hill90` (app's `POSTGRES_DB`) | **0** | 0 | Nothing at all. Never used |
| `keycloak` (on app-postgres) | 89 | 1569 | **Real data — and out of scope.** See §7 |

### `hill90_api` is not empty, and that needed proving

It holds 105 rows, and "greenfield" would have been the wrong word for it without
checking:

```
schema_migrations   65      tools               15      skills               9
skill_tools          7      model_catalog        5      container_profiles   3
model_policies       1      everything else      0
```

Those are **seed rows, not user data** — the tools/skills catalogue, the model
catalogue, container profiles. The question that matters is whether a fresh
database reproduces them or whether cutover loses them. Two pieces of evidence say
reproduces:

**They are created by migrations.** `INSERT`s into exactly these tables live in
`services/api/src/db/migrations/` — `004_create_model_router_tables.sql`,
`007_seed_embedding_models.sql`, `021_tools_and_profile_reset.sql`,
`023_seed_github_and_docker_skills.sql`,
`026_normalize_seed_skill_tool_dependencies.sql`,
`032_create_container_profiles.sql`, `039_add_profile_metadata_and_seed.sql`,
`045_seed_tmux_tool_and_skill.sql`, `046_seed_browser_tool_and_skill.sql`,
`060_seed_web_search_skill.sql`.

**Nothing was added afterwards by hand.** Every row's `created_at` falls inside
the migration run itself — a 960-millisecond window:

```
schema_migrations ran   2026-07-29 05:01:03.007762+00 .. 05:01:03.967732+00
tools               15 rows   created 05:01:03.369593 .. 05:01:03.962812
skills               9 rows   created 05:01:03.369593 .. 05:01:03.962812
model_catalog        5 rows   created 05:01:03.075803 .. 05:01:03.167705
container_profiles   3 rows   created 05:01:03.552210 .. 05:01:03.632853
model_policies       1 row    created 05:01:03.075803
```

If a human had created a tool, a skill or a profile through the API since deploy,
its timestamp would sit outside that window. None does. (`skill_tools` has no
`created_at`; it is a join table written by migration `026`.)

**Conclusion, per database:** there is nothing to migrate, dump, or restore
anywhere. Each service recreates its own schema and seeds on first boot against an
empty database. The `pg_dump` in Hill90's backups stays a safety net, not a step.

**One consequence worth stating**, because it is the only user-visible difference:
the seeded rows will have **new primary keys and new timestamps** after cutover.
Nothing references them from outside the database — no config file pins a tool or
skill id — but if anything ever did, this is where it would break.

---

## 2. Every place a database connection is resolved

`hill90-app`, read 2026-07-30. Grouped by what the change does to each.

### 2a. The four connection strings that actually change

| File:line | Service | Database | Current value |
|---|---|---|---|
| `deploy/compose/prod/docker-compose.api.yml:119` | `app-api` | `hill90_api` | `DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@app-postgres:5432/hill90_api` |
| `deploy/compose/prod/docker-compose.ai.yml:82` | `app-ai` | `hill90_api` | `DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@app-postgres:5432/hill90_api` |
| `deploy/compose/prod/docker-compose.ai.yml:40` | `app-litellm` | `hill90_litellm` | `DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@app-postgres:5432/hill90_litellm` |
| `deploy/compose/prod/docker-compose.knowledge.yml:44` | `app-knowledge` | `hill90_akm` | `AKM_DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@app-postgres:5432/hill90_akm` |

**Note the first two rows.** `app-api` and `app-ai` point at the *same database*.
They are one unit of work, not two — see §5.

### 2b. Credentials and secret plumbing

| File:line | What it is |
|---|---|
| `deploy/compose/prod/.env.example:13-15` | `DB_USER`, `DB_PASSWORD`, `DB_NAME` — the documented surface |
| `infra/secrets/prod.enc.env` | the app's own SOPS store: `DB_USER`, `DB_PASSWORD` |
| `scripts/deploy.sh:126` | required secrets for `api` — includes `DB_USER DB_PASSWORD` |
| `scripts/deploy.sh:127` | required secrets for `ai` — includes `DB_USER DB_PASSWORD` |
| `scripts/deploy.sh:128` | required secrets for `knowledge` — includes `DB_USER DB_PASSWORD` |
| `scripts/deploy.sh:124` | required secrets for `db` — `DB_USER DB_PASSWORD` (stays; app-postgres keeps running) |
| `scripts/deploy.sh:125` | required secrets for `auth` — `DB_USER DB_PASSWORD` (out of scope, §7) |

### 2c. Deploy-time readiness checks that reach into the wrong container

| File:line | What it does | Why it matters |
|---|---|---|
| `scripts/deploy.sh:243-248` | `docker exec app-postgres psql -U $DB_USER -tAc 'SELECT 1'` for the `db` service | Still correct for `db`, and note it proves nothing about the tenant role: in-container `psql` authenticates by `trust` |
| `scripts/deploy.sh:326-328` | same check, guarding the `auth` deploy | Out of scope (§7) |
| `scripts/deploy.sh:97` | maps service `db` → container `app-postgres` | Unchanged |
| `scripts/deploy.sh:151` | summary text: *"app-postgres — the app's own database. Hill90's asserts platform-only databases."* | **Stale.** Hill90's check now asserts tenant isolation and accepts a provisioned tenant. Fix the string as part of this change |

### 2d. Local development — deliberately not changed

`compose/local.yml` is the **standalone** stack with its own Postgres, whose
compose service key is already `postgres`. The host string is therefore identical
in all three modes and needs no per-mode handling:

`compose/local.yml:68-70`, `:77`, `:79` (its own postgres), `:113-115` (keycloak),
`:154` (litellm), `:184` (api), `:244` (ai), `:286` (knowledge);
`deploy/compose/overrides/local.db.yml:16`, `:22`; `.env.local.example:22-23`;
`scripts/local.sh:209-210`.

### 2e. Provisioning that becomes dead code for production

| File | Fate |
|---|---|
| `scripts/provision-akm-db.sh:23-48` | Superseded in production by Hill90's `provision-tenant-db.sh`. Still needed for the standalone local stack |
| `scripts/provision-litellm-db.sh:28-41` | Same |
| `platform/data/postgres/init.sh:4-33` | The app's own bootstrap. Still the right thing for `app-postgres` and the standalone local stack. **Do not delete while `app-postgres` exists** |

`platform/ai/litellm_config.yaml:45` reads `database_url: os.environ/DATABASE_URL`
and needs no change.

---

## 3. What each becomes, and the key names

The platform side already exists (`Verified 2026-07-30 01:35 UTC`): role
`hill90_app`, databases `hill90_api`, `hill90_akm`, `hill90_litellm`, owned by that
role, `PUBLIC` revoked, `uuid-ossp` and `vector` pre-installed.

### New keys in the app's own store — do not reuse `DB_USER`/`DB_PASSWORD`

`DB_USER` and `DB_PASSWORD` currently mean *"the superuser of `app-postgres`"* and
are consumed by `app-postgres` itself (`docker-compose.db.yml:36-37`) and by
`app-keycloak` (`docker-compose.auth.yml:30-31`). Both keep running throughout.
**Overwriting them would break `app-postgres` and `app-keycloak` in the same
motion, and would make per-service rollback impossible.** Add new keys instead:

| New key in `hill90-app`'s `infra/secrets/prod.enc.env` | Value |
|---|---|
| `PLATFORM_DB_HOST` | `postgres` |
| `PLATFORM_DB_USER` | `hill90_app` |
| `PLATFORM_DB_PASSWORD` | copy of Hill90's `HILL90_APP_DB_PASSWORD` |

Source of truth is **Hill90's** `HILL90_APP_DB_PASSWORD`
(`infra/secrets/prod.enc.env`, vault path `secret/tenants/hill90-app/database`).
Read it with `make secrets-get KEY=HILL90_APP_DB_PASSWORD` in the Hill90 checkout.
The app's copy is a replica; if they disagree, re-run Hill90's provisioner with the
value from Hill90, which resets the password idempotently.

Each of the four lines in §2a becomes, with only host/user/password changing:

```yaml
# docker-compose.api.yml:119  and  docker-compose.ai.yml:82
- DATABASE_URL=postgresql://${PLATFORM_DB_USER}:${PLATFORM_DB_PASSWORD}@${PLATFORM_DB_HOST}:5432/hill90_api

# docker-compose.ai.yml:40
- DATABASE_URL=postgresql://${PLATFORM_DB_USER}:${PLATFORM_DB_PASSWORD}@${PLATFORM_DB_HOST}:5432/hill90_litellm

# docker-compose.knowledge.yml:44
- AKM_DATABASE_URL=postgresql://${PLATFORM_DB_USER}:${PLATFORM_DB_PASSWORD}@${PLATFORM_DB_HOST}:5432/hill90_akm
```

Add `PLATFORM_DB_HOST PLATFORM_DB_USER PLATFORM_DB_PASSWORD` to the required-secret
lists at `scripts/deploy.sh:126`, `:127`, `:128`, and to
`deploy/compose/prod/.env.example`.

`PLATFORM_DB_HOST` is a variable rather than a literal `postgres` because the app's
invariant 3 forbids hardcoding a name that exists on the shared host — even though,
as measured below, the literal would in fact work in every mode.

---

## 4. Four measurements that make this smaller than it looks

**The network path already exists.** Every DB-consuming service is already attached
to `hill90_internal` (`docker-compose.api.yml:84-89`, `ai.yml:31-33` and `:70-74`,
`knowledge.yml:34-38`). No network change, no compose restructure.

**`postgres` already resolves, from all four containers.** Measured on the VPS:

```
app-api        -> 172.19.0.9      app-ai         -> 172.19.0.9
app-knowledge  -> 172.19.0.9      app-litellm    -> 172.19.0.9
platform postgres = 172.19.0.9    app-postgres   = 172.19.0.13
```

**The alias survives a container prefix**, because Compose derives it from the
*service key*, not `container_name` — the mechanism behind invariant 4. Locally:
`hill90dev-postgres` carries `aliases=[hill90dev-postgres postgres]`, and
`hill90dev-app-api` resolves `postgres` → `172.21.0.9`. So the same host string is
correct in prod, in local-tenant mode, and in the standalone stack.

**Migrations run themselves on boot.** `services/api/src/index.ts:18` calls
`runMigrations(getPool())`; `services/knowledge/app/main.py:70` calls
`run_migrations(pool)`; LiteLLM applies its Prisma migrations on start, evidenced by
`_prisma_migrations` holding 77 rows on a database nothing else populated. So an
empty platform database becomes a correct one without a manual step.

---

## 5. The order, and what "proven" means

`app-postgres` keeps serving throughout. Nothing is deleted. Each step is a
one-service (or one-database) deploy through the pipeline —
`gh workflow run "Manual Deploy App (Prod)"`, `dry_run=true` first, never from a
workstation.

**Order the work by database, not by service.** The grouping is forced:

| Step | Deploy | Database | Why here |
|---|---|---|---|
| 1 | `ai` (litellm half) | `hill90_litellm` | Smallest blast radius. Nothing else reads it; its data is migrations only |
| 2 | `knowledge` | `hill90_akm` | Single consumer. 12 rows, all migrations |
| 3 | `api` **and** `ai` together | `hill90_api` | **Both read this database.** Splitting them means two services running against two different copies of one logical database — a split brain that will not announce itself |

Step 3 is the awkward one: `ai` appears in steps 1 and 3 because
`docker-compose.ai.yml` holds both `litellm` (its own database) and `ai` (the api's
database). Either accept deploying `ai` twice, or fold steps 1 and 3 together and
lose the smallest-first ordering. **Deploying `ai` twice is the safer trade** — it
keeps the first cutover to a database no other service touches.

### "Proven" per service — and none of these is container health

A healthy container proves the process started. For `api` it does not even prove
the database was reached: `services/api/src/index.ts:45` logs *"DATABASE_URL not
set, skipping migrations"* and **carries on starting**. A typo in the variable name
produces a green container with no schema. Check the database, not the container.

**Step 1 — litellm / `hill90_litellm`.** Proven when, on the *platform* Postgres:

```bash
docker exec postgres psql -U hill90 -d hill90_litellm -tAc \
  "SELECT count(*) FROM \"_prisma_migrations\""      # expect 77
```

plus `app-litellm` healthy, and a model call through the router succeeding.
Also confirm no new connections remain to `app-postgres/hill90_litellm` in
`pg_stat_activity`.

**Step 2 — knowledge / `hill90_akm`.** Proven when, on the platform Postgres:

```bash
docker exec postgres psql -U hill90 -d hill90_akm -tAc \
  "SELECT count(*) FROM schema_migrations"           # expect 12
docker exec postgres psql -U hill90 -d hill90_akm -tAc \
  "SELECT count(*) FROM pg_stat_user_tables"         # expect 14
```

plus a knowledge write-then-read through the API, so the proof exercises the
connection rather than only the schema.

**Step 3 — api + ai / `hill90_api`.** Proven when, on the platform Postgres:

```bash
docker exec postgres psql -U hill90 -d hill90_api -tAc \
  "SELECT count(*) FROM schema_migrations"           # expect 65
docker exec postgres psql -U hill90 -d hill90_api -tAc \
  "SELECT (SELECT count(*) FROM tools)||'/'||(SELECT count(*) FROM skills)
        ||'/'||(SELECT count(*) FROM model_catalog)" # expect 15/9/5
```

The seed counts are the real assertion: they prove the migrations ran *and* seeded,
which is the difference between an empty schema and a working one. Then, through
the app: list tools, list skills, and create an agent — that last one writes, so it
proves the tenant role has more than `CONNECT`.

**After every step:** Hill90 stays at exactly 13 containers, 0 unhealthy, and
`bash scripts/local.sh health`'s tenant-isolation line stays green.

---

## 6. Rollback, per step

Rollback is a redeploy, not a restore, and that is the whole point of leaving
`app-postgres` running: **its schema and data stay untouched and current-as-of-now
for the entire exercise.** There is no window in which both databases are being
written, because a service points at exactly one.

| Step | Rollback |
|---|---|
| 1 | Revert `docker-compose.ai.yml:40` to `@app-postgres:5432/hill90_litellm`; redeploy `ai`. LiteLLM finds its old schema and resumes |
| 2 | Revert `docker-compose.knowledge.yml:44`; redeploy `knowledge` |
| 3 | Revert `docker-compose.api.yml:119` **and** `docker-compose.ai.yml:82` together; redeploy `api` and `ai`. Reverting one alone recreates the split brain |

The platform-side databases can be left in place on rollback — they are inert if
nothing points at them, and Hill90's health check stays green either way. If they
should be removed, that is `DROP DATABASE` ×3 plus `DROP ROLE hill90_app` on the
platform, which is **not** part of any step here.

Anything written to a platform database between cutover and rollback is lost. Given
§1 that means: nothing, unless a human used the app in the interval. If they did,
the seeded catalogues are still reproducible but that person's agent or knowledge
entry is not. Cut over when nobody is using it, which today is always true — no
human has completed a sign-in.

---

## 7. Explicitly out of scope

**The `keycloak` database on `app-postgres` is not part of this.** It holds 89
tables, 1569 rows, realms `hill90` and `master`, and users `hill90admin`, `jon`,
`testuser01` (plus `admin` in `master`) — `Verified 2026-07-30`. That is the
tenant's identity store and it belongs to the Keycloak consolidation, not the
Postgres cutover.

It also **cannot** be moved as-is: the platform's own identity database is *also*
named `keycloak`. Same shape as the `prod_postgres-data` volume collision that
nearly mounted the platform's live database under a second Postgres. Hill90's
provisioner refuses `keycloak` as a tenant database name, so the mistake fails
loudly — but do not go looking for a way around it. Under the settled one-realm
decision the app stops shipping Keycloak, and this database is retired rather than
migrated.

`app-postgres`'s default `hill90` database collides with the platform's `hill90` in
exactly the same way. It has 0 tables, so nothing wants moving.

Also out of scope: deleting `app-postgres` or any `prod_app-*` volume (only after
all three steps are proven and have sat for a while), `app-minio`, and the
`auth`-stack lines at `docker-compose.auth.yml:29-31`.

---

## 8. Two hazards to fix while making the change

**`services/knowledge/app/config.py:9` hardcodes a fallback DSN:**

```python
database_url: str = "postgresql://postgres:postgres@postgres:5432/hill90_akm"
```

Its host is already `postgres` and its database is already `hill90_akm` — so after
cutover this default is *correct except for the credentials*, and it fails only
because role `postgres` does not exist. This is the same family as the
`auth.hill90.com/realms/hill90` issuer fallback: a default that is wrong today,
becomes nearly right later, and turns a missing variable into a puzzle instead of
an error. **Delete the default and fail loudly on a missing
`AKM_DATABASE_URL`**, as was recommended for the issuer fallbacks.

**`services/api/src/index.ts:45` skips migrations silently** when `DATABASE_URL` is
unset, and starts anyway. During a cutover, where the variable name is changing,
that converts a typo into a green container with no schema. Either fail on a
missing `DATABASE_URL` or, at minimum, do not accept container health as proof for
step 3 — use the seed-count query in §5.

---

## See also

- [tenant-databases-on-platform-postgres.md](tenant-databases-on-platform-postgres.md)
  — the platform side: the tenant role, the boundary, and how it was verified
- [platform-primitives.md](platform-primitives.md) — why Postgres is a platform
  service
- [app-tenancy-on-the-vps.md](app-tenancy-on-the-vps.md) — the tenancy contract
