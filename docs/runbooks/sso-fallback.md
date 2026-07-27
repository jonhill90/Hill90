# Getting in when Keycloak is down

Keycloak SSO is wired into Grafana, Portainer and OpenBao (issue #530). Doing
that creates an obvious hazard: the identity provider becomes something you
depend on in order to administer the infrastructure you would need in order to
fix the identity provider.

**So Keycloak is never the only way in.** Every service keeps a local admin
login, and this page is how you use it. Each path below has been exercised with
Keycloak fully stopped, not merely written down.

## The short version

| Service | Fallback | Where the credential lives |
|---|---|---|
| Grafana | `admin` + password on the normal login form | `GRAFANA_ADMIN_PASSWORD` in SOPS |
| Portainer | `admin` + password on the normal login form | `PORTAINER_ADMIN_PASSWORD` in SOPS |
| OpenBao | AppRole (or root token, if one still exists) — token auth, not OIDC | AppRole creds in SOPS; see below |

Nothing needs to be reconfigured first. The local login form is present on every
one of these at all times.

## Why the form is still there

Two settings do all the work, and both are pinned deliberately:

- **Grafana** — `GF_AUTH_DISABLE_LOGIN_FORM=false` and
  `GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN=false`. Either one flipped to `true` would
  skip or hide the username/password form and make Keycloak the only route in.
- **Portainer** — the OAuth setting `SSO` is `false`. Portainer's `SSO` flag
  hides its internal login form; `scripts/portainer.sh` never enables it.

Grafana also uses **explicit** OAuth endpoint URLs rather than OIDC discovery.
Discovery would have Grafana fetch metadata from Keycloak, coupling Grafana's
startup to the IdP being reachable. With explicit URLs it does not.

## Verifying the fallback yourself

With Keycloak stopped entirely:

```bash
docker stop keycloak

# Grafana — expect your user object back
curl -s -u "admin:$GRAFANA_ADMIN_PASSWORD" https://grafana.hill90.com/api/user

# Portainer — expect a JWT
curl -s -X POST https://portainer.hill90.com/api/auth \
  -H "Content-Type: application/json" \
  -d "{\"Username\":\"admin\",\"Password\":\"$PORTAINER_ADMIN_PASSWORD\"}"

# OpenBao — token auth, unaffected by OIDC.
# AppRole is the durable path: vault.sh revoke-root DELETES the root token file,
# and docs/runbooks/vault-unseal.md tells you to run it, so on a fully
# bootstrapped host /opt/hill90/secrets/openbao-root.token will NOT exist.
ROLE_ID=$(bash scripts/secrets.sh get infra/secrets/prod.enc.env VAULT_INFRA_ROLE_ID)
SECRET_ID=$(bash scripts/secrets.sh get infra/secrets/prod.enc.env VAULT_INFRA_SECRET_ID)
docker exec -e BAO_ADDR=http://127.0.0.1:8200 openbao \
  bao write auth/approle/login role_id="$ROLE_ID" secret_id="$SECRET_ID"

# If the root token still exists (pre-revocation host), this also works:
docker exec -e BAO_ADDR=http://127.0.0.1:8200 \
  -e BAO_TOKEN="$(cat /opt/hill90/secrets/openbao-root.token)" \
  openbao bao token lookup

docker start keycloak
```

Locally the same thing runs against the `hill90dev-` containers. `local.sh up`
brings the whole stack back regardless of Keycloak's state.

**Result when this was last run** (local stack): with Keycloak *stopped*, Grafana
started healthy and the local admin logged in, Portainer started and issued a JWT
to the internal admin, and OpenBao token auth resolved. The same held with
Keycloak *paused*, with the SSO clients deleted, and with the whole realm
deleted. Grafana logged no OAuth errors at boot.

Reproduce it locally with `bash scripts/local.sh up`, `bash scripts/local.sh sso`,
then `docker stop hill90dev-keycloak` and the commands above against the
`hill90dev-` containers.

## Granting people access through SSO

Assign a realm role — that is the whole model:

```bash
docker exec keycloak /opt/keycloak/bin/kcadm.sh add-roles \
  -r platform --uusername <user> --rolename admin
```

`admin`, `editor` and `viewer` exist in the `platform` realm.

**Grafana** maps them automatically: `admin` → Admin, `editor` → Editor,
anything else → Viewer. Note this is Grafana **organisation** Admin, not Grafana
*server* admin: `GF_AUTH_GENERIC_OAUTH_ALLOW_ASSIGN_GRAFANA_ADMIN=false`, so
`isGrafanaAdmin` stays false and an SSO admin cannot do everything the local
`admin` account can. That is deliberate — it keeps the local account strictly
more powerful than any SSO identity. Verified against a real token — the realm role appears in
both the ID token and the userinfo response as `realm_access.roles`.

**Portainer Community Edition cannot do this.** Claim-to-team mapping and
automatic admin rights are Business Edition features. An SSO user is created
automatically but arrives as a **standard user**, and someone has to promote them
once, signed in as the local admin:

> Users → *the user* → set Role to Administrator

Equivalently via the API, `PUT /api/users/:id` with `{"Role": 1}` (1 =
administrator, 2 = standard) — verified against the running 2.39.5 instance.

That is a per-person, one-time step, and it is the main rough edge in this setup.

**OpenBao** maps the realm `admin` role to the `policy-oidc-admin` policy through
the `admin-sso` role, configured by `vault.sh setup-oidc`.

## When something is wrong

**Grafana shows no "Sign in with Keycloak" button.** SSO is off. Check
`GRAFANA_OIDC_ENABLED`, which can be set to `false` to disable SSO entirely — the
quickest way to rule OAuth out while debugging.

**Keycloak rejects the login with `Invalid parameter: redirect_uri`.** The
client's registered redirect URIs do not match the URL the service is using. Run
`scripts/keycloak.sh apply`, which sets them from the public URLs, and check with
`scripts/keycloak.sh status`.

**The token exchange fails with `invalid_client`.** The client secret in Keycloak
and the one the service holds have diverged. Both come from SOPS, so re-running
`scripts/keycloak.sh apply` restores agreement. Note this failure appears *after*
a successful Keycloak login, which makes it look like the service is broken
rather than the credential.

**A new SSO user can log in to Portainer but can see nothing.** Expected — see
the promotion step above.

**Realm changes appear to do nothing.** `platform-realm.json` is imported only on
Keycloak's first boot; editing it later changes nothing while still logging
"Import finished successfully". Use `scripts/keycloak.sh apply`. See
[the Keycloak README](../../platform/auth/keycloak/README.md).

## What is not covered

**MinIO is not deployed.** Issue #530 lists it, but there is no MinIO service in
this repository — it was removed with the application in #495 and no compose file
exists. Its SSO is therefore **deferred, not done**, and will be part of whatever
work deploys MinIO in the first place.
