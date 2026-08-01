# Stage 1 — distinct platform realm roles, and jon's admin-console grants

Option B, per Jon's decision. Evidence base: [`sso-claim-measurement-2026-08-01.md`](sso-claim-measurement-2026-08-01.md) (#635) — not re-derived here.

`Applied to production 2026-08-01. Codified afterwards — see "Ordering" below.`

## Ordering: production changed before the repository did

**This PR does not describe work it is about to do. It describes work already live.**

Stage 1 was executed against production Keycloak and proven with a real token; the session
then ended on an API error before the change was written back to the repository. Jon
independently verified the live state read-only from the Keycloak database. So for a period,
production held realm roles and grants the repository knew nothing about — **the exact drift
this estate keeps getting bitten by**, and closing it was the first job on resuming.

Recording this rather than presenting the PR as if it came first, because the ordering is
the thing a future reader needs to know: if this file and the realm disagree, the realm was
here first.

## What is live, and what now reproduces it

| Object | Live | Reproduced by |
|---|---|---|
| realm role `platform-admin` | yes | `REALM_ROLES` in `scripts/keycloak.sh` **and** `platform-realm.json` |
| realm role `platform-viewer` | yes | same |
| `jon` → `platform-admin` | yes | `ensure_platform_admins()`, called from `cmd_apply` |
| `jon` → `realm-management`: `manage-users`, `view-clients`, `view-realm` | yes | same |
| old roles `admin`, `user`, `editor`, `viewer` | **untouched** | unchanged — deliberately not deleted |

Both halves are additive. Nothing was repointed; every consumer still binds exactly what it
bound before.

## The narrow set: measured, not assumed

Jon asked for the narrowest set that actually works rather than `realm-admin`. Measured
against the live admin API on 2026-08-01, as `jon`, with invalid payloads so that nothing
was created — `403` means denied, `400` means permitted-but-rejected:

**Permitted**

```
GET  /admin/realms/platform                      200
GET  /admin/realms/platform/users                200
GET  /admin/realms/platform/clients              200
GET  /admin/realms/platform/roles                200
GET  /admin/realms/platform/groups               200
GET  .../users/{id}/role-mappings                200
GET  .../users/{id}/role-mappings/realm/available 200
POST /admin/realms/platform/users                400   (permitted, payload rejected)
POST /admin/realms/platform/groups               400   (permitted, payload rejected)
```

**Denied — say this plainly, because it is what Jon cannot do**

```
POST /admin/realms/platform/roles                403   cannot create realm roles
POST /admin/realms/platform/clients              403   cannot create or manage clients
PUT  /admin/realms/platform                      403   cannot change realm settings
GET  /admin/realms/platform/identity-provider/instances 403
GET  /admin/realms/platform/events               403   cannot view login events
```

So `manage-users` + `view-clients` + `view-realm` lets Jon **administer people**: create
users, assign and remove their realm and client roles — which is what granting somebody
`platform-admin` requires. It does not let him change the shape of the realm.

**The one gap worth flagging:** he cannot view login events. CLAUDE.md records that event
storage is on and "did this user log in, and when" is answerable from the host — but not by
Jon in the console, without `view-events`. **Widening is a decision, not an oversight**, so
it is recorded rather than taken.

## Reproducibility on a rebuild — tested, and half of it is a no-op

The concern is the #634 class: a grant that exists only because a command was run once.

**Roles: reproduce.** `platform-realm.json` was imported into a throwaway Keycloak 26.4.0:

```
Realm 'platform' imported / Import finished successfully
roles: [admin, default-roles-platform, offline_access, platform-admin,
        platform-viewer, uma_authorization, user]
platform-admin present on a from-nothing realm: True
platform-viewer present on a from-nothing realm: True
```

**Grants: cannot, and the code says so out loud.** The realm import ships **zero users** by
design, so on a rebuilt realm there is no `jon` to grant to:

```
users on a fresh realm: NONE
```

`ensure_platform_admins()` therefore **warns and continues** rather than failing or
skipping silently — a silent skip would be the same trap in a new costume. The honest
statement is: *the roles survive a rebuild; the grants do not, and the rebuild path must
recreate the accounts and re-run `keycloak.sh apply`.* That is a known gap in the realm
import, already recorded in CLAUDE.md as "a directory rebuild locks everyone out".

**Idempotency verified against production** — re-running every grant left the role set
byte-identical:

```
before: [default-roles-platform, offline_access, platform-admin, uma_authorization]
after : [default-roles-platform, offline_access, platform-admin, uma_authorization]
IDEMPOTENT: role set unchanged
realm-management: [manage-users, view-clients, view-realm]
```

## Proof that jon carries platform-admin

Real tokens, authorization-code flow, the method #635 used:

```
hill90-vault  user=jon
  realm_access.roles : [default-roles-platform, offline_access, platform-admin, uma_authorization]
  realm_roles        : [default-roles-platform, offline_access, platform-admin, uma_authorization]

minio         user=jon
  realm_access.roles : [default-roles-platform, offline_access, platform-admin, uma_authorization]
  minio_policy       : [default-roles-platform, offline_access, platform-admin, uma_authorization]
```

`platform-admin` is carried in all three claim shapes the consumers read.

## An instrument trap found on the way

**`admin-cli` issues a lightweight access token. It is useless for claim inspection.**

Getting a token for `jon` from `admin-cli` and decoding it produced:

```
payload keys: [azp, exp, iat, iss, jti, scope, sid, typ]
preferred_username : None
realm_access.roles : []
```

No `sub`, no `preferred_username`, no `realm_access`. **The token is valid** — the same
token returned `200` from every admin endpoint — because Keycloak resolves permissions
server-side from the session rather than from claims in the token.

So: `admin-cli` is fine for **probing permissions** and blind for **inspecting claims**.
Decoding one and finding no roles is *blindness, not absence* — see `CONTRIBUTING.md`,
*Verify the Instrument Before You Believe the Verdict*. Use an authorization-code flow
through a real client when the question is "what does this token carry".

## Rollback

### Stage 1 (this change)

Purely additive; nothing is repointed, so **no consumer behaviour changes and there is
nothing to roll back for correctness**. To reverse anyway:

```bash
kcadm delete-roles -r platform --uusername jon --rolename platform-admin
kcadm delete-roles -r platform --uusername jon --cclientid realm-management --rolename manage-users
kcadm delete-roles -r platform --uusername jon --cclientid realm-management --rolename view-clients
kcadm delete-roles -r platform --uusername jon --cclientid realm-management --rolename view-realm
kcadm delete roles/platform-admin  -r platform
kcadm delete roles/platform-viewer -r platform
```

Then revert this PR. **Risk: none to access** — Jon's route into Keycloak is the `master`
realm admin account, which this does not touch.

### Stage 2a — Grafana

Change: `GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH`, `admin` → `platform-admin`.
Rollback: revert the compose line and redeploy observability through the pipeline.
**Fallback if it goes wrong:** the Grafana local admin login — `GF_AUTH_DISABLE_LOGIN_FORM=false`,
`GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN=false`, **verified working 2026-08-01** (`POST /login` →
`200 {"message":"Logged in"}`, and that account is org `Admin`). Worst case is Jon logs in
locally and sets the role by hand.

### Stage 2b — OpenBao

Change: `bound_claims` `{"realm_roles":["admin"]}` → `{"realm_roles":["platform-admin"]}`,
written at runtime with `bao write auth/oidc/role/admin-sso`.
Rollback: write the previous value back — the old role still exists, so the old binding is
restorable exactly.
**Fallback: NOT EXERCISED, and this is the weakest link.** `VAULT_SYNC_TOKEN` in the store
**did not validate**, so there is no confirmed non-OIDC token today. The remaining route is
the unseal key → `bao operator generate-root`; its inputs are verified present (encrypted
store **and** `/opt/hill90/secrets/openbao-unseal.key`, `0600`), but exercising it mints a
root credential, which is a change and a security event, so it was not tested.
**Do not start Stage 2b without deciding whether that is acceptable.**

### Stage 3 — MinIO

Not designed yet. The claim is populated and wrong rather than absent, so a rename is not
obviously the fix.
**Fallback:** MinIO's root credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) are in
the store and are independent of OIDC.

## Out of scope, recorded not answered

- **Portainer** — CE cannot map claims to admin rights at any value (#635). Needs a manual
  Administrator promotion, written into a runbook, not automated.
- **LiteLLM** — no client, no OIDC configuration; it is `app-litellm` in hill90-app and
  authenticates by master key. Whether it should have SSO at all is a tenant question.
- **The zero-holder roles** `admin`, `user`, `editor`, `viewer` are **deliberately not
  deleted**. They become safe to remove only once every consumer is repointed and proven,
  which is a separate PR.
