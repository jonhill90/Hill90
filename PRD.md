# Hill90 — Product Requirements

> **Historical: this is the requirements document for the 2026-07-26 app/infra
> strip, not a description of Hill90 today.** The split it argues for happened, and
> the tenant it produced now runs against this platform — so the *cost/benefit
> argument* below is settled and the *architecture* it describes is superseded by
> [docs/decisions/app-tenancy-on-the-vps.md](docs/decisions/app-tenancy-on-the-vps.md),
> which defines the contract this platform actually offers a tenant. Its reasoning
> about Keycloak and Postgres was wrong and is corrected in
> [docs/decisions/platform-primitives.md](docs/decisions/platform-primitives.md).
> Kept as the record of a decision that was carried out.

**Status:** implemented 2026-07-26
**Author:** strip-app lane
**Date:** 2026-07-26

## Problem

Hill90 is two projects in one repository. Roughly 595 of its ~800 tracked files
live under `services/` and belong to an AI agent application that has not run
since June 2026, when the prod VPS was destroyed and rebuilt on AlmaLinux 10 as a
deliberate scope reduction (`ee94b43`). Only the infra and observability stacks
were redeployed.

The cost of that split is paid continuously. CI builds and tests four
application runtimes on every pull request. `README.md` is roughly 40% app
content. `CONTRIBUTING.md` documents seven deploy commands for services that
cannot be deployed. Dependabot files vulnerability alerts against application
dependencies nobody runs. An operator reading this repo cannot tell, without
running `docker ps` on the host, which half is real.

The decision to separate the application from the platform was made on
2026-07-11. This is the implementation.

## What Hill90 becomes

A live, deployable homelab infrastructure repository for a single operator.

Concretely: the automation that takes a bare Hostinger VPS to a running,
TLS-terminated, observable, Tailscale-secured Docker host — and keeps it there.
Hill90 remains a domain and a running machine, not an application platform.

The scope after this change is exactly what is deployed today:

| Layer | Contents |
|---|---|
| Provisioning | Hostinger VPS lifecycle, Ansible bootstrap, OS hardening, Tailscale, Docker |
| Edge | Traefik with DNS-01 ACME via lego's built-in Cloudflare provider, Portainer |
| Observability | Prometheus, Grafana, Loki, Tempo, Promtail, node-exporter, cAdvisor |
| Secrets | SOPS/age at rest, OpenBao as the runtime source of truth, schema validation |
| Operations | Deploy, verify, backup, rollback, health, DNS sync |

## Users

There is one user: Jon, operating a personal homelab.

That singularity is a design input, not a footnote. It means no multi-tenancy,
no RBAC beyond what Traefik basic-auth and Tailscale ACLs already provide, no
staging environment, and no onboarding path to optimise for. It also means the
repository must be legible after months away from it, because that is the normal
working condition.

A second, indirect consumer exists: the `docker-infra-template` lane, which will
lift generic patterns out of this repo. Hill90 stays Hill90-specific; the
template is a separate parallel effort.

## Goals

1. **Every file in the repository corresponds to something real.** No component
   remains that cannot be deployed to the running host.
2. **The live stacks keep working.** `deploy.sh infra prod` and
   `deploy.sh observability prod` must behave identically before and after.
3. **A rebuild still works end to end.** The documented VPS-recreate path —
   `vps.sh recreate` → `vps.sh config` → `deploy.sh infra` →
   `deploy.sh observability` — remains the tested recovery story.
4. **CI stays green and gets faster.** All six check families
   (bats, pytest, shellcheck, markdown-link, secrets-schema, compose validation)
   pass, with the four application runtimes no longer built.
5. **Removals are coherent.** A removed component leaves behind no compose
   entry, deploy case, workflow, test assertion, doc reference, secrets-schema
   entry, DNS record, or Makefile target.
6. **The app is recoverable.** Its history is preserved and findable.
7. **The app/infra boundary is written down** in a form the template lane can
   use directly.

## Non-goals

- **Not a repo split.** Hill90 stays one repository and stays operational. The
  application moves to `hill90-app` as a separate lane's work; this lane consumes
  that outcome, it does not produce it.
- **Not the generic template.** `docker-infra-template` is a parallel effort.
  Nothing here should be genericised in anticipation of it.
- **Not a Kubernetes migration.** `k8s-cluster-template` is separate; the
  `k8s-homelab` repo stays archived and untouched.
- **Not a rewrite of the infrastructure.** Traefik, the observability stack, the
  deploy scripts and the secrets model are kept as they are. This is subtraction,
  not redesign.
- **Not a re-litigation of the separation decision.** The application lives in
  `hill90-app` and has run as a tenant of this platform since 2026-07-29.
- **Not a cleanup of pre-existing infra drift.** Known DNS drift
  (`vps.hill90.com` and `openclaw.hill90.com` still pointing at a stale address)
  is recorded, not fixed here.

## Decisions carried into this work

These were settled before the spec was written and are treated as fixed inputs.

- **OpenBao/vault stays.** It is the secrets architecture — `scripts/vault.sh`,
  `scripts/_common.sh`, the systemd unseal unit, the weekly `vault-sync-to-sops`
  workflow and `check_secrets_schema.py` all depend on it — not an application
  dependency. Only the five app policy files and the app KV paths go.
- **Keycloak, Postgres and MinIO are removed.** None of the three is running
  today, so none constrains the live host. Each loses its last consumer when the
  application goes: Keycloak served api/mcp/ui, Postgres served Keycloak, MinIO
  served the API. Keycloak's `hill90-vault` OIDC client is not worth carrying a
  full identity provider for in a single-operator homelab that already has a
  working token path. All three are re-addable if a real consumer appears.
- **`docs/site/` moves to `hill90-app`.** It is application documentation —
  quickstart, API reference, agent concepts — and describes nothing Hill90
  becomes. Salvaging a homelab docs site out of it would be a rewrite, not a
  migration. Internal `docs/` stays in Hill90.
- **Archiving has two layers**: an annotated tag `archive/app-stack-final` on the
  last commit containing the full `services/` tree, and the `hill90-app` history
  extraction, which is the real archive.

## Definition of done

The work is complete when all of the following hold.

**Repository state**

- [x] `services/` no longer exists — `dns-manager` was its last occupant and was
      deleted when DNS-01 moved to Cloudflare.
- [ ] `deploy/compose/prod/` contains exactly three files: `docker-compose.infra.yml`,
      `docker-compose.observability.yml`, `docker-compose.vault.yml`.
- [ ] `deploy/compose/dev/` no longer exists.
- [ ] `platform/` contains exactly three directories: `edge`, `observability`, `vault`.
- [ ] `scripts/deploy.sh` accepts exactly `infra`, `vault`, `observability`,
      `verify`, `backup`, `help` — and no application stack names.
- [ ] No file outside `docs/decisions/` references `api`, `ai`, `ui`, `mcp`,
      `knowledge`, `agentbox`, `litellm`, `model-router`, `keycloak`, `postgres`
      or `minio` as a live component. Historical references in the decision
      record are expected and correct.

**Verification**

- [ ] All six CI check families pass on the pull request.
- [ ] `docker compose config` validates every surviving compose file.
- [ ] `bash scripts/validate.sh all` passes.
- [ ] On the VPS, `deploy.sh infra prod` and `deploy.sh observability prod`
      complete and `deploy.sh verify` reports healthy for both — run only with
      explicit approval in the same turn.
- [ ] The ten running containers are still the ten running containers.
- [ ] Grafana loads with no broken dashboards and Prometheus reports no
      permanently-down scrape targets.

**Documentation**

- [ ] `README.md` and `CONTRIBUTING.md` describe only what exists.
- [ ] `CONTRIBUTING.md`'s command map lists only executable commands.
- [ ] The markdown link checker reports zero broken links.

**Archive**

- [ ] `archive/app-stack-final` exists and is pushed to `origin`.
- [ ] The `hill90-app` extraction is complete and verified — a hard precondition
      for any deletion here.

## Success measure

The honest one: six months from now, Jon opens this repository, reads the
README, and can rebuild the host without needing to remember which half was real.
