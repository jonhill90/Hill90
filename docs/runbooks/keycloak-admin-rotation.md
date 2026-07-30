# Rotating the Keycloak `master`-realm admin password

**Prepared 2026-07-30, not executed.** Written because production
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

**Caveat, stated rather than hidden:** `--new-password` puts the value in the
container's argv, readable via `/proc` for the duration of the call. On this host
that is not an escalation — anyone who can read `/proc` is `deploy` or `root`, and
`deploy` already holds the age key to the whole secrets store. If you want to avoid
it anyway, the Admin REST API accepts the value in a request body
(`PUT /admin/realms/master/users/{id}/reset-password`, `--data-binary @-` from
stdin). **I could not verify that variant locally** — the `master` realm ships
`sslRequired=external`, so plain-HTTP admin calls return
`403 {"error":"invalid_request","error_description":"HTTPS required"}`; only
`platform` is relaxed locally. On production, where `auth.hill90.com` is HTTPS, it
would work.

## 2. Update the store, and the vault path

```bash
make secrets-update KEY=KC_ADMIN_PASSWORD VALUE='<new password>'
```

Schema path is `secret/auth/config` (`platform/vault/secrets-schema.yaml`), so the
OpenBao copy needs the same value if vault is being kept in step.

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
