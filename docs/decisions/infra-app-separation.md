# Infra/App Separation

**Status:** decided, not implemented
**Decided:** 2026-07-11
**Recorded:** 2026-07-25 (salvaged from working session notes before those
notes were deleted)

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

## Status and Open Items

Nothing has been implemented. No branch, no extraction, no new repositories.
This repo remains structurally unchanged — `services/`, `platform/`, `infra/`,
and `deploy/compose` are all still present.

Deferred details, to be settled when the work actually starts:

- Exact content inventory for each boilerplate repo
- The cert-manager / ingress-nginx / ArgoCD / observability manifest set
- Secrets and config templating approach
- Whether the Kubernetes boilerplate carries its own node preparation or
  references the Docker one

## Provenance

The decision was reached in a working session on 2026-07-11 and never written
down at the time. It survived only in local session transcripts, which were
removed during the harness cleanup. This document is the salvaged record.
