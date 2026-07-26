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
