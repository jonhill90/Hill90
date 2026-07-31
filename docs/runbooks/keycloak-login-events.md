# "Did this user log in, and when?"

**Answering it takes one command.** Everything else on this page is why that command
is shaped the way it is, and what it cannot tell you.

`Verified 2026-07-31 03:30 UTC` — enabled, and proven by completing a login as
`testuser01` and reading the row back out of the database.

---

## The command

```bash
ssh vps
docker exec postgres psql -U hill90 -d keycloak -c "
SELECT to_timestamp(e.event_time/1000) AT TIME ZONE 'UTC' AS utc_time,
       e.type, u.username, e.client_id, e.ip_address, r.name AS realm
FROM event_entity e
LEFT JOIN user_entity u ON u.id = e.user_id
LEFT JOIN realm      r ON r.id = e.realm_id
WHERE u.username = 'THE_USERNAME'
ORDER BY e.event_time DESC LIMIT 20;"
```

Real output, from the verification run:

```
      utc_time       |    type     |    who     | client_id | ip_address  |  realm
---------------------+-------------+------------+-----------+-------------+----------
 2026-07-31 03:30:22 | LOGIN_ERROR | testuser01 | admin-cli | 76.13.26.69 | platform
 2026-07-31 03:29:52 | LOGIN       | testuser01 | admin-cli | 76.13.26.69 | platform
```

Everyone, most recent first — drop the `WHERE` clause. **No rows for a user means no
recorded login since events were switched on**, which is not the same as never — see
the next section.

## Read this before you conclude anything from an empty result

**1. Nothing exists before 2026-07-31 ~03:28 UTC.** Event storage was off from the day
this estate was built until then. Keycloak does not backfill. For any question about an
earlier date the honest answer is *"not recorded"*, not *"did not happen"*.

**2. Retention is 30 days.** Older rows are deleted by Keycloak's own periodic task. A
question about two months ago has no answer here either.

**3. An empty `event_entity` is not evidence that nobody logged in.** That sentence is
the reason this page exists. Sessions live in **Infinispan, not the database**, so a
logged-in user leaves no database row while their session is alive, and before this
change nothing wrote to `event_entity` at all. More than one session in July 2026 had to
say this out loud after reading an empty table.

**4. Only four event types are stored** on `platform`: `LOGIN`, `LOGIN_ERROR`, `LOGOUT`,
`LOGOUT_ERROR`. A token refresh, a consent grant or a password reset is *not* here.

## Traps in the schema

Each of these will silently give you a wrong answer rather than an error.

| Trap | What happens | What to do |
|---|---|---|
| `realm_id` is a **UUID**, not `platform` | `WHERE realm_id = 'platform'` matches nothing and looks like "no logins" | join `realm r ON r.id = e.realm_id` |
| `event_time` is **epoch milliseconds** | `to_timestamp(event_time)` gives a date in the year 57000-odd | divide by 1000, as above |
| Timestamps come back in **server local time** unless you ask | off-by-hours answers | keep `AT TIME ZONE 'UTC'`, and compare against UTC |
| `user_id` is null for a failed login with an **unknown username** | a `LEFT JOIN` shows a blank user | the attempted name is in `details_json` |

## Is the IP trustworthy?

Reasonably. Keycloak runs with `KC_PROXY_HEADERS=xforwarded`, so it records the client
address from Traefik's `X-Forwarded-For` rather than Traefik's own. In the verification
run above the client genuinely *was* the VPS — the login was driven from the host — so
`76.13.26.69` is correct rather than a proxy artefact. Treat the column as good enough to
distinguish "from the office" from "from somewhere else", not as forensic evidence.

## Admin events: who changed the configuration

Enabled on both realms, and answers a different question — *what was changed by hand,
outside git*.

```bash
docker exec postgres psql -U hill90 -d keycloak -c "
SELECT to_timestamp(admin_event_time/1000) AT TIME ZONE 'UTC' AS utc_time,
       operation_type, resource_type, resource_path, auth_user_id, ip_address
FROM admin_event_entity ORDER BY admin_event_time DESC LIMIT 20;"
```

**`representation` is deliberately empty.** `adminEventsDetailsEnabled` is off, because
that column stores the full JSON of the changed resource — and a client representation
carries its `secret`. Switching it on would write client secrets in plaintext into the
platform Postgres, and from there into every database backup. The audit value is *who
changed what, when*, which `operation_type` and `resource_path` already give.

If you ever need the representation for one specific investigation, turn it on, capture
what you need, and turn it straight back off — then treat the database backups taken in
between as containing secrets.

## Where this lands, and what it costs

- **Database `keycloak` on the platform Postgres** (container `postgres`) — the same
  database every other platform service depends on, which is why retention is bounded
  rather than infinite.
- Tables `event_entity` and `admin_event_entity`.
- Scale: the whole `keycloak` database was **13 MB** with both tables empty. An event row
  is a few hundred bytes, so 30 days of this estate's traffic is noise. Check it with:

```bash
docker exec postgres psql -U hill90 -d keycloak -c "
SELECT relname, n_live_tup,
       pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables WHERE relname LIKE '%event%' ORDER BY relname;"
```

- Backups: covered by the existing platform Postgres backup. Nothing extra to configure.

## Changing what is recorded

Configuration lives in `scripts/keycloak.sh` (`ensure_event_logging`, called from
`cmd_apply`) and in `platform/auth/keycloak/platform-realm.json` for a fresh import.
**Change it there, not in the admin console** — `keycloak.sh apply` reconciles the realm
and would put a console change back.

Retention and event types are overridable per-run:

```bash
KC_EVENTS_EXPIRATION=604800 bash scripts/keycloak.sh apply     # 7 days instead of 30
KC_EVENT_TYPES="LOGIN LOGIN_ERROR REFRESH_TOKEN" bash scripts/keycloak.sh apply
```

`events/config` updates **replace the whole object**, so any field left out reverts to
the server default. That is why `ensure_event_logging` names every field explicitly, and
why a hand-rolled `kcadm update` is a bad idea at 3am.

### Why `master` is configured differently

`master` records `LOGIN` and `LOGIN_ERROR` only — no logout. It holds no application
users, so "did a user log in" is not a question anyone asks of it. The reason to record
there is narrower: the master admin credential leaked and was rotated on 2026-07-30, and
without a login record there was no way to answer whether it had been used in between.
That question recurs at every rotation. A logout on an admin realm tells you nothing the
login did not.

## Verifying it still works

If you doubt the pipeline, generate a failed login — it needs no password and touches
nobody's account:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://auth.hill90.com/realms/platform/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=password&client_id=admin-cli&username=no-such-user&password=x'
# 401, then a LOGIN_ERROR row should appear within a second or two
```

A row appearing proves the whole path: Keycloak → JPA event listener → platform
Postgres. Config that says `eventsEnabled: true` proves only that the config says so.

## See also

- [keycloak-admin-rotation.md](keycloak-admin-rotation.md) — the rotation this exists to
  make answerable
- [sso-fallback.md](sso-fallback.md) — when Keycloak itself is the problem
