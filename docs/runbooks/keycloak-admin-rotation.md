# Rotating the Keycloak `master`-realm admin password

**Prepared 2026-07-30. EXECUTED 2026-07-30 ~07:5x UTC** — corrections from that run are
marked *Contact* below. The credential was rotated; the leaked value is dead. Written because production
`KC_ADMIN_PASSWORD` was exposed in an agent transcript and is still valid — see
[../decisions/2026-07-30-credential-exposures.md](../decisions/2026-07-30-credential-exposures.md).
Rotating it is Jon's call.

Every step below was **rehearsed against the local platform Keycloak**
(`quay.io/keycloak/keycloak:26.4.0`, the same image production runs) and the local
state was restored afterwards. Where something could not be verified locally, it
says so.

---

## Read this first: the env-variable route does not work

`docker-compose.auth.yml` sets `KC_BOOTSTRAP_ADMIN_USERNAME` and
`KC_BOOTSTRAP_ADMIN_PASSWORD` from the store. **Those apply only on FIRST
startup, when the realm has no admin.** Changing them in SOPS and redeploying
`auth` does nothing to the existing admin account — Keycloak starts cleanly, logs
nothing unusual, and the old password keeps working.

Somebody will try that route and conclude the rotation "didn't take". It is not a
rotation at all. **This is an admin-API change plus a SOPS update.**

The order matters in one direction only: change Keycloak first or the store first,
but until both are done `keycloak.sh` and the `auth` deploy's SSO reconcile step
will fail to authenticate. That step is deliberately non-fatal, so nothing breaks —
it just stops reconciling until the pair agrees.

---

## 0. Before you start: check the lockout risk, and put break-glass in place

**Contact — added after the run. Neither of these was in the original.**

**Check brute-force protection first.** Proving the old password is dead means
deliberately failing an authentication, and that is only safe if you know the lockout
posture. In Keycloak 26 these live in `realm_attribute`, **not** on the `realm` table —
querying `realm.brute_force_protected` errors with "column does not exist":

```bash
docker exec postgres psql -U hill90 -d keycloak -tA -F' = ' -c \
 "SELECT ra.name, ra.value FROM realm_attribute ra JOIN realm r ON r.id=ra.realm_id
   WHERE r.name='master' AND (ra.name ILIKE '%brute%' OR ra.name ILIKE '%failure%'
      OR ra.name ILIKE '%lockout%') ORDER BY ra.name"
```

Measured 2026-07-30: `bruteForceProtected = false`, `permanentLockout = false`,
`failureFactor = 30`. One deliberate failure is therefore free. **If that ever reads
`true`, budget your failed attempts against `failureFactor` before you begin.**

**Create break-glass BEFORE rotating, not as a rollback step.** The original runbook
kept `bootstrap-admin` in the rollback section, which is too late to discover it does
not work. Creating it first proves the path end to end *and* leaves a way back:

```bash
# sidecar; kc.sh cannot run in the live container (binds :9000)
docker run --rm --network hill90_internal \
  -e KC_DB=postgres -e KC_DB_URL="<keycloak's own KC_DB_URL>" \
  -e KC_DB_USERNAME -e KC_DB_PASSWORD -e BG_PW \
  quay.io/keycloak/keycloak:26.4.0 \
  bootstrap-admin user --username breakglass --password:env BG_PW
```

Then authenticate as `breakglass` against the running server to prove it works, and
**delete the account once the rotation is verified** — it is a safety net, not a
fixture. Confirm `master` is back to a single `admin` user afterwards.

## 1. Rotate the password in Keycloak

Get the admin user's id, then set the new password. `kcadm` inside the container
talks to `127.0.0.1:8080`, which is exempt from `sslRequired`, so this works
regardless of TLS settings.

```bash
ssh deploy@<vps>

# Authenticate. The password goes through the ENVIRONMENT, not argv — this is the
# pattern scripts/keycloak.sh:100 uses, and the reason it uses it.
KC_CLI_PASSWORD='<current admin password>' \
  docker exec -e KC_CLI_PASSWORD keycloak /opt/keycloak/bin/kcadm.sh \
    config credentials --server http://127.0.0.1:8080 --realm master --user admin

ID=$(docker exec keycloak /opt/keycloak/bin/kcadm.sh \
       get users -r master -q username=admin --fields id \
       --format csv --noquotes | tr -d '\r')

docker exec keycloak /opt/keycloak/bin/kcadm.sh \
  set-password -r master --userid "$ID" --new-password '<new password>'
```

**Contact — use the stdin form below, not `--new-password`.** `--new-password` puts
the value in the container's argv. There is a fully argv-free path and it is the one
that was actually used:

```bash
NEW="<new password>" python3 -c '
import os, json
print(json.dumps({"type":"password","value":os.environ["NEW"],"temporary":False}))' \
 | docker exec -i keycloak /opt/keycloak/bin/kcadm.sh \
     update "users/$ID/reset-password" -r master -f -
```

`kcadm -f -` reads the body from stdin, so neither password touches argv: the
authentication uses `KC_CLI_PASSWORD` via `docker exec -e`, and the new value arrives
on stdin. Verified: `rc=0`, and both directions confirmed immediately afterwards.

**Contact — the Admin REST variant this runbook previously recommended DOES NOT WORK
here.** The earlier text said the direct-grant token call would work on production
because `auth.hill90.com` is HTTPS. It does not:

```
POST https://auth.hill90.com/realms/master/protocol/openid-connect/token
{"error":"invalid_grant","error_description":"Invalid user credentials"}
```

with the *correct* password, while `kcadm` against `http://127.0.0.1:8080` accepted the
same value seconds later, and `admin-cli` in `master` has `directGrant=true`,
`enabled=true`. Do not spend time on it; use the kcadm stdin form.

## 2. Update the store, and the vault path

```bash
make secrets-update KEY=KC_ADMIN_PASSWORD VALUE='<new password>'
```

**Contact — there is no OpenBao copy to update, and none can be made.** The schema
names `secret/auth/config`, which invites the assumption that vault must be updated
too. Checked on the host:

- `vault.sh cmd_seed` seeds only `secret/infra/traefik`, `secret/infra/vps` and
  `secret/observability/grafana`. **`secret/auth/config` was never seeded.**
- The AppRole credentials in SOPS no longer authenticate — an `auth` AppRole login is
  **refused** — so `vault_load_secrets` fails and `deploy.sh` falls through to SOPS, as
  its own comment says it will.
- The root token is **revoked** (`/opt/hill90/secrets/openbao-root.token` absent),
  `generate-root` is disabled *(recoverable — see
  [`stage2b-oidc-blocked-2026-08-02.md`](../decisions/stage2b-oidc-blocked-2026-08-02.md);
  the CLI's 403 came from a legacy path)*, and **nothing is bound to `policy-admin`** — `setup`
  creates AppRoles only for `db auth infra observability`, all read-only. So there is
  no write-capable credential for OpenBao at all.
- `cmd_sync_to_sops`'s `SYNC_PATHS` covers only traefik/vps/grafana, so the sync
  **cannot** overwrite `KC_ADMIN_PASSWORD` in SOPS. That clobber risk does not exist.

**SOPS is the operative store for this credential.** Updating it is sufficient and is
the whole job. Restoring a writable vault is separate work and is not a prerequisite
for rotating this password.

Confirm without printing it:

```bash
make secrets-get KEY=KC_ADMIN_PASSWORD | tr -d '\n' | shasum -a 256 | cut -c1-12
```

## 3. Verify — BOTH halves

"The new one works" is not "the old one stopped working". Check both.

```bash
# new value: expect success
KC_CLI_PASSWORD='<new password>' docker exec -e KC_CLI_PASSWORD keycloak \
  /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master --user admin && echo ACCEPTED

# OLD value: expect failure
KC_CLI_PASSWORD='<old password>' docker exec -e KC_CLI_PASSWORD keycloak \
  /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master --user admin \
  && echo "STILL VALID — ROTATION DID NOT TAKE" || echo REFUSED
```

Rehearsed locally, both halves observed:

```
after rotation:
  new pw -> OK
  OLD pw -> REFUSED
```

Then confirm the store and Keycloak agree, by using the store's value:

```bash
KC_ADMIN_PASSWORD="$(make secrets-get KEY=KC_ADMIN_PASSWORD)" \
  bash scripts/keycloak.sh status
```

## 4. Blast-radius checks, AFTER the rotation

**Expected impact is nil**, and that is a claim to test rather than assume. None of
the SSO consumers use the admin credential — Grafana uses
`GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET`, Portainer `PORTAINER_OIDC_CLIENT_SECRET`,
OpenBao `VAULT_OIDC_CLIENT_SECRET`, and `KC_ADMIN*` appears in neither `vault.sh`
nor `portainer.sh`. A user-password change cannot alter a client secret. Check each
anyway, and note none of these checks needs the admin credential:

| Service | Check | Expected |
|---|---|---|
| Grafana | `curl -s -D - -o /dev/null https://grafana.hill90.com/login/generic_oauth` | `302` with `Location:` pointing at `auth.hill90.com/realms/platform` |
| Portainer | `curl -s https://portainer.hill90.com/api/settings/public` | `AuthenticationMethod: 3` (OAuth) and an `OAuthLoginURI` containing `realms/platform` |
| OpenBao | `curl -s -X POST https://vault.hill90.com/v1/auth/oidc/oidc/auth_url -d '{"role":"","redirect_uri":"https://vault.hill90.com/ui/vault/auth/oidc/oidc/callback"}'` | JSON `data.auth_url` containing `realms/platform` |
| The app | complete a sign-in at `hill90.com` | reaches an authenticated page |

Verification status of those checks, honestly:

- **Grafana — verified locally.** Returned `302` to
  `http://auth.localtest.me:8080/realms/platform...`.
- **Portainer — shape verified, not the value.** Locally it reports
  `AuthenticationMethod: 1` (internal) with no `OAuthLoginURI`, because local
  Portainer SSO was never applied. Production should report `3`.
- **OpenBao — not verified.** The local OpenBao is uninitialized and sealed
  (`initialized: false, sealed: true`), so the OIDC method does not exist there and
  the endpoint 404s. The check is correct in shape; it is untested.

Also confirm the realm's clients are untouched — five plus the built-ins:

```bash
docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r platform \
  --fields clientId --format csv --noquotes | sort
# expect: grafana, hill90-api, hill90-ui, hill90-vault, portainer + Keycloak built-ins
```

---

## 5. Rollback — and yes, there is a break-glass

**This is the section that matters**, because getting the rotation wrong means
losing the admin API for the realm that fronts every infra surface.

### If you still have a working admin session

Set the password back with the step-1 command. Nothing else to undo — no restart, no
config change, no client touched.

### If the admin path is lost entirely

**There is a break-glass, and it needs no downtime.** Keycloak 26.4.0 ships
`kc.sh bootstrap-admin user`, which writes an admin directly to the database.

**It cannot run inside the live container.** Rehearsed, and it fails:

```
ERROR: Unable to start the management interface on 0.0.0.0:9000
ERROR: Address already in use
```

Run it from a **sidecar** against the same database instead — the same shape this
estate already proved for the realm export. Rehearsed locally, and it worked with the
server left running:

```bash
docker run --rm --network hill90_internal \
  -e KC_DB=postgres \
  -e KC_DB_URL="jdbc:postgresql://postgres:5432/keycloak" \
  -e KC_DB_USERNAME='<DB_USER>' -e KC_DB_PASSWORD='<DB_PASSWORD>' \
  -e BG_PW='<break-glass password>' \
  quay.io/keycloak/keycloak:26.4.0 \
  bootstrap-admin user --username breakglass --password:env BG_PW
```

Then authenticate as `breakglass` against the running server, fix the real admin,
and **delete the break-glass account**:

```bash
BG=$(docker exec keycloak /opt/keycloak/bin/kcadm.sh get users -r master \
       -q username=breakglass --fields id --format csv --noquotes | tr -d '\r')
docker exec keycloak /opt/keycloak/bin/kcadm.sh delete "users/$BG" -r master
```

Rehearsal confirmed the whole path, including that the account authenticates against
the live server and that deleting it leaves `master` with only `admin`.

**Note `--password:env`**, not `--password`. It reads the value from an environment
variable so it never appears in argv — the same discipline as step 1.

### What makes this genuinely low-risk

There is exactly **one** login account in `master` (`admin`), so there is no second
admin to fall back on — which is why the sidecar matters. It is worth considering a
standing second admin account as a follow-up, but that is a decision, not part of
this rotation.

---

## Do not

- **Do not** change the env vars and redeploy expecting a rotation. See the top.
- **Do not** write the new value onto any *client* secret. Client secrets are
  unrelated to the admin user, and overwriting one breaks that service's SSO
  immediately.
- **Do not** recreate the Keycloak container or its volume. The realm lives in
  Postgres; a fresh volume is not a rotation, it is a rebuild, and
  `platform-realm.json` imports only on first boot.


---

## Execution record — 2026-07-30

Password generated as `[A-Za-z0-9]{32}` (no punctuation, no base64 padding, nothing a
shell, a `%q` requote or a SOPS round-trip can mangle).

- **Both directions proven**: new ACCEPTED, old REFUSED. A rotation tested only in the
  positive direction is half a rotation.
- **SOPS round-trips byte-identically**: read back out and compared — same sha256,
  32 chars, `[A-Za-z0-9]{32}` preserved.
- **The value in SOPS authenticates against production**, not just the value in the
  operator's hand — store and server agree end to end.
- Break-glass created before, verified, and removed after; `master` back to one user.
- Platform baseline held throughout: 13/13 by name, 0 unhealthy, `keycloak` healthy.
- Surfaces after: `hill90.com` 200, platform discovery 200, grafana 302, portainer 200,
  vault 307. `hill90.com` login still redirects to
  `auth.hill90.com/realms/platform/protocol/openid-connect/auth`.
