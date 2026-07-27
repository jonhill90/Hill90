# Hill90 as an open-source mirror of the Azure platform primitives

**Status:** decided, recorded 2026-07-26
**Supersedes the reasoning in:** [infra-app-separation.md](infra-app-separation.md)

## Why this document exists

Hill90 is not a minimal homelab that happens to run some services. It is a
deliberate open-source counterpart to the platform primitives Jon works with
professionally on Azure. Each component was chosen because it is the OSS analogue
of something he uses at work, so that operating Hill90 builds and keeps
transferable skill.

**That intent was never written down.** The consequence was not hypothetical:
during the strip on 2026-07-26, Keycloak and Postgres were reasoned about purely
as *application dependencies*, found to have no surviving consumer once the app
was removed, and deleted. That conclusion was correct given the information
recorded — and wrong given the actual intent.

It happened **three separate times in one day**. Each time the footprint argument
beat the capability argument, because footprint was written down and capability
was not:

1. **The strip itself** ([#495](https://github.com/jonhill90/Hill90/pull/495)) —
   "Keycloak served api/mcp/ui, Postgres served Keycloak, therefore both go."
2. **The vault/SOPS decision** ([vault-vs-sops.md](vault-vs-sops.md)) — OpenBao
   recommended dormant until "a concrete consumer" appeared, treating a platform
   primitive as though it needed to justify itself per-feature.
3. **The OIDC teardown** ([#495](https://github.com/jonhill90/Hill90/pull/495),
   SPEC §2.9) — vault SSO removed because "the `hill90-vault` client was its only
   remaining consumer… not worth carrying a full IdP for one operator."

Every one of those arguments is locally sound and collectively wrong. This
document exists so the next one loses.

## The mapping

| Azure (work) | Hill90 (open source) | Role |
|---|---|---|
| Entra ID | **Keycloak** | Identity provider, OIDC/OAuth2, realms and roles |
| Key Vault | **OpenBao** | Secrets, policies, short-lived credentials |
| Storage Account | **MinIO** | S3-compatible object storage |
| Azure Monitor / Log Analytics | **OTEL + Prometheus, Loki, Tempo, Grafana** | Metrics, logs, traces, dashboards |
| Application Gateway / Front Door | **Traefik** | Edge routing, TLS termination, WAF-ish middleware |
| VNet / Private Link | **Tailscale** | Private network, no public admin surface |
| Azure DNS | **Cloudflare DNS + lego (in Traefik)** | DNS as code, DNS-01 issuance |
| Azure Database for PostgreSQL | **Postgres** | Managed relational store for platform services |

## What follows from it

**These are platform services, not application dependencies.** A platform
primitive does not have to justify itself by pointing at a current consumer, any
more than a VNet justifies itself by naming a VM. The question is whether the
capability belongs in the platform, not whether something is using it this week.

**"No current consumer" is not an argument for removal.** It is an argument that
the platform is under-used, which is a different problem with a different fix.

**Multi-user is a real requirement, not a hypothetical.** Family accounts, demo
accounts and test accounts are all expected. That is precisely what an identity
provider is for, and it is why "one operator doesn't need an IdP" was the wrong
frame — the operator count is not one.

**Footprint arguments need an explicit counterweight.** Roughly 700 MB of RAM for
Keycloak and Postgres is a real cost on a 15 GB host, but it is the cost of the
capability, not waste. Where footprint genuinely matters, say so with numbers
against the capability, rather than treating unused-today as free-to-delete.

## Consequences for how things are shaped

**Realm per consumer.** The old Keycloak held a single `hill90` realm mixing
platform and application clients — `hill90-vault` alongside `hill90-ui` and
`hill90-api`. That conflated the IdP with its first tenant. The new shape is one
realm per consumer, with the AI application as *one tenant among several*.
Platform realms ship with Hill90; application realms ship with the application.

**Postgres serves the platform, not the app.** The old `init.sh` created
`keycloak` plus `hill90_api`, `hill90_akm` and `hill90_litellm`. Only the first
is a platform concern. Application databases belong with the application.

**Platform-to-platform SSO is legitimate; platform-to-infrastructure is not.**
OpenBao authenticating humans against Keycloak is exactly what the pairing is
for, and is restored. Wiring **Grafana, Portainer or Traefik** to Keycloak is
not: it would make the edge and observability stacks unable to start unless the
IdP is healthy, turning a convenience into a availability dependency on the very
services you need working in order to debug an outage. Those keep local auth.

**The observability coupling was collateral.** Removing Postgres and Keycloak
also removed their Prometheus scrape targets, Grafana dashboards and the
`PostgresConnectionsHigh` alert. Restoring the services restores those.

## What this does not change

The application strip itself was correct. The AI agent app is shelved, lives in
`hill90-app`, and is not coming back into this repository. Removing
`services/api`, `services/ai`, `services/ui`, `services/mcp`,
`services/knowledge` and `services/agentbox` stands. LiteLLM and the model-router
were application components and stay gone.

What was wrong was classifying two *platform* services as application
dependencies because the only thing recorded about them was who happened to be
calling them.

## See also

- [Infra/app separation](infra-app-separation.md) — the strip, and the reasoning this document corrects
- [Vault vs SOPS](vault-vs-sops.md) — the secrets decision, which should now be read with the mapping above in mind
