# Infra/App Separation

**Status:** implemented
**Decided:** 2026-07-11
**Recorded:** 2026-07-25 (salvaged from working session notes before those
notes were deleted)
**Implemented:** 2026-07-26

## Context

Hill90 grew into a combined repository: infrastructure automation (Ansible
bootstrap, deploy scripts, Traefik/Portainer/observability compose, SOPS
secrets, Tailscale) alongside an AI agent application stack under `services/`
(api, ai, ui, mcp, knowledge, chat, agentbox).

In June 2026 the prod VPS was destroyed and rebuilt on AlmaLinux 10 as a
deliberate scope reduction. Only the infra and observability stacks were
redeployed; the application stack was left undeployed. That change is recorded
in commit `ee94b43`.

A separate `k8s-homelab` repository (kind cluster, cert-manager, ArgoCD,
observability, AdGuard) exists from earlier work and is likewise stale.

## Decision

Hill90 becomes a homelab domain rather than an application host. The AI agent
application is shelved.

The reusable value in both repositories is extracted into **two generic infra
boilerplates**:

1. **Both repos are generic boilerplates**, not Hill90-specific live infra.
   They may be used for a homelab or for hosting an application.
2. **The two repos are independent**, not layered — you pick one per project
   rather than stacking one on the other.
3. **Both are fresh repositories.** Hill90 and `k8s-homelab` stay archived and
   untouched as sources to extract from. The `services/` tree and
   app-specific `platform/` configs are archived separately or deleted.
4. **The Kubernetes boilerplate uses kubeadm + containerd + Calico** with
   stacked etcd — "the real thing" rather than k3s, chosen for the etcd
   backup/restore experience that k3s's SQLite datastore would not provide.
   Single-node capable today, `kubeadm join` for more nodes later over
   Tailscale.
5. **They live on the personal GitHub account, public**, with descriptive
   names — e.g. `docker-infra-boilerplate` and `k8s-cluster-boilerplate`.

### Why kubeadm over k3s

k3s and kubeadm give an identical Kubernetes API, kubectl, and manifest/Helm
experience; the differences are bootstrap and footprint. kubeadm was chosen
deliberately for hands-on exposure to etcd, CNI, and certificate management,
which is closer to managing a real on-prem cluster. kubeadm v1.35 with
containerd and Calico is confirmed working on AlmaLinux 10 / Rocky 10.1.

## Implementation

Carried out on 2026-07-26 across four pull requests, planned in
[PRD.md](../../PRD.md) and [SPEC.md](../../SPEC.md):

| Step | Change |
|---|---|
| #494 | Removed the eight application services, their compose files, workflows, tests and secrets |
| #495 | Removed Keycloak, Postgres and MinIO; vault lost OIDC SSO with them |
| #496 | Documentation rewritten to describe the infrastructure repo |
| JON-29 | Observability configuration — Prometheus targets, alert and dashboards |

What remains is three stacks and ten containers: edge (Traefik, dns-manager,
Portainer), observability (the LGTM stack plus collectors), and OpenBao.
`services/dns-manager` was kept — it is live infrastructure, the DNS-01 ACME
webhook Traefik depends on, not application code.

The application is preserved two ways: the `archive/app-stack-final` tag on
this repository, and the `hill90-app` repository, which holds the eight services
extracted with full history.

### Deviations from the original decision

- **Hill90 was not archived.** The decision anticipated extracting into fresh
  boilerplates and leaving this repo untouched. Instead Hill90 stayed live and
  operational and had the application removed in place, because the infra and
  observability stacks are still deployed and still wanted.
- **The generic boilerplates are a separate effort.** `docker-infra-template`
  and `k8s-cluster-template` are parallel work; the app/infra inventory in
  `SPEC.md` §7 is the artifact handed to them.

### Open items

- Kubernetes boilerplate content and manifest set (unchanged, deferred)
- Secrets and config templating approach for the boilerplates (deferred)
- OpenBao is retained but not currently deployed; it holds no secrets that the
  three running stacks cannot get from SOPS

## Provenance

The decision was reached in a working session on 2026-07-11 and never written
down at the time. It survived only in local session transcripts, which were
removed during the harness cleanup. This document is the salvaged record.
