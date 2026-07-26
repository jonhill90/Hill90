# Keycloak — platform identity provider

Keycloak is a **platform primitive**: the open-source counterpart to Entra ID.
See [platform-primitives.md](../../../docs/decisions/platform-primitives.md).

## Realm per consumer

`platform-realm.json` holds **platform clients only** — currently `hill90-vault`,
which lets OpenBao authenticate humans via OIDC.

Application realms do **not** live here. The AI application is one tenant among
several and ships its own realm from the `hill90-app` repository. The previous
shape put `hill90-ui` and `hill90-api` in the same realm as `hill90-vault`, which
conflated the identity provider with its first tenant and is a large part of why
Keycloak looked like an application dependency and was deleted in #495.

To add a consumer, add a realm — not a client to this one.

## What may and may not authenticate against it

**May.** Platform-to-platform SSO. OpenBao is wired to it (`vault.sh setup-oidc`,
`policy-oidc-admin.hcl`). That is exactly the Key-Vault-behind-Entra pairing this
project mirrors.

**May not.** Grafana, Portainer and the Traefik dashboard keep local auth
deliberately. Routing them through Keycloak would mean the edge and observability
stacks cannot be reached unless the identity provider is healthy — an
availability dependency on the IdP for precisely the tools you need in order to
debug an IdP outage. Convenience is not worth that.

## Themes

`themes/hill90/` is branding and applies to whatever realms reference it. It is
platform-level and stays here.

## This file is applied on FIRST BOOT ONLY

`docker-compose.auth.yml` runs `start --import-realm`, whose strategy is
`IGNORE_EXISTING`. Keycloak's own guide states: *"If a realm already exists in
the server, the import operation is skipped… to avoid re-creating realms and
potentially lose state between server restarts."*

So once the `platform` realm exists in Postgres, **editing this file changes
nothing.** Verified against Keycloak 26.4.0: with the realm present, a restart
logs

```
KC-SERVICES0030: Full model import requested. Strategy: IGNORE_EXISTING
Realm 'platform' already exists. Import skipped
KC-SERVICES0032: Import finished successfully
```

Note the last line — it says success. `deploy.sh verify auth` only checks Docker
health, so a merge that edits this file deploys green and applies nothing.

**To change the live realm after first boot**, apply it explicitly:

```bash
docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master --user "$KC_ADMIN_USERNAME"
docker exec keycloak /opt/keycloak/bin/kcadm.sh update realms/platform -s <setting>=<value>
```

...and make the same edit here, so a future rebuild from empty agrees with the
running server. The two can silently diverge; nothing currently detects that.

## The OIDC client secret

`hill90-vault` sets `"secret": "${VAULT_OIDC_CLIENT_SECRET}"`. Keycloak
substitutes environment variables into realm files at import — verified on
26.4.0 by re-importing and reading the value back through `kcadm`.

This matters because the secret is otherwise **generated at random by Keycloak**,
while `vault.sh setup-oidc` reads `VAULT_OIDC_CLIENT_SECRET` from SOPS. Those two
values cannot match, and nothing detects the mismatch: `setup-oidc` prints
success, Keycloak authenticates the user correctly, and only the back-channel
token exchange fails — as `invalid_client`, from OpenBao, which makes it look
like a vault fault. Sourcing both sides from SOPS removes the failure entirely.

Set `VAULT_OIDC_CLIENT_SECRET` in SOPS to a strong random value **before the
first auth deploy**. Rotating it later requires updating the live client too,
because of the first-boot rule above.
