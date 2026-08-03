# Hill90 Architecture Overview

*This document describes the high-level architecture of the Hill90 VPS.*

## System Architecture

Hill90 is homelab infrastructure on a single Hostinger VPS running AlmaLinux 10.
It is not an application host: it provides identity, data and storage, and the
[hill90-app](https://github.com/jonhill90/hill90-app) AI application consumes them
as a **tenant**, serving `hill90.com`. The contract is
[App tenancy on the VPS](../decisions/app-tenancy-on-the-vps.md).

### Components

- **Edge Layer**: Traefik reverse proxy with automatic HTTPS (dual certificate resolvers), Portainer, and the DNS-01 challenge webhook
- **Observability Layer**: LGTM stack (Loki, Grafana, Tempo, Prometheus) with collectors
- **Secrets Layer**: OpenBao vault, with SOPS/age as the bootstrap and DR backup
- **Infrastructure Layer**:
  - Docker Compose orchestration
  - Tailscale VPN (secure admin access)
  - Ansible playbooks (host provisioning)

### Network Topology

```
Internet                         Tailscale Network (100.64.0.0/10)
   ↓                                     ↓
Traefik (edge network)           ┌──────────────────────────┐
   ↓                             │ Admin Services           │
┌─────────────────────────────┐  │ - Traefik Dashboard      │
│ Public entrypoints          │  │ - Portainer UI           │
│ - :80  (HTTP-01 validation, │  │ - Grafana                │
│         redirect to :443)   │  │ - OpenBao UI             │
│ - :443 (TLS termination)    │  └──────────────────────────┘
└─────────────────────────────┘           ↓ (DNS-01 certs)
                                 ┌──────────────────────────┐
   ↓                             │ DNS Manager              │
┌─────────────────────────────┐  │ (Webhook for ACME)       │
│ Internal (hill90_internal)  │  └──────────────────────────┘
│ - Loki (logs)               │           ↓
│ - Tempo (traces)            │  Hostinger DNS API
│ - Promtail (log collector)  │  (TXT record management)
│ - Node Exporter (host)      │
│ - cAdvisor (containers)     │
└─────────────────────────────┘
   ↓
┌─────────────────────────────┐
│ Edge + internal             │
│ - Prometheus (metrics)      │
│ - Grafana (dashboards)      │
│ - OpenBao (secrets)         │
└─────────────────────────────┘
```

**Certificate Management:**
- **Public hostnames** use HTTP-01 challenge (Let's Encrypt validates via port 80)
- **Tailscale-only hostnames** use DNS-01 challenge (Let's Encrypt validates via DNS TXT records) — they have no public A record, so HTTP-01 cannot reach them
- DNS Manager translates Traefik ACME requests to Hostinger DNS API calls

**Network Isolation:**
- **edge network**: Traefik and the services it routes
- **internal network**: `internal: true`, unreachable from outside the host
- **agent_internal network**: `internal: true`, created by the edge stack and used by the hill90-app tenant (`app-api`, `app-ai`)
- **Tailscale network**: admin-only surfaces (Traefik dashboard, Portainer, Grafana, OpenBao)
- **IP Whitelist**: 100.64.0.0/10 (Tailscale CGNAT range) via Traefik middleware

`docker-compose.infra.yml` is the sole owner of all three Docker networks; the
observability and vault stacks attach to them as external.

## Service Responsibilities

- **Traefik**: Reverse proxy, load balancer, automatic HTTPS
  - HTTP-01 challenge for public hostnames
  - DNS-01 challenge for Tailscale-only hostnames, via lego's built-in
    Cloudflare provider (`CF_DNS_API_TOKEN`) — no helper service
  - Dashboard at https://traefik.hill90.com (Tailscale-only)
- **Portainer**: Docker container management UI at https://portainer.hill90.com (Tailscale-only)
- **OpenBao**: Secrets management at https://vault.hill90.com (Tailscale-only), token-authenticated
- **Prometheus / Grafana / Loki / Tempo**: Metrics, dashboards, logs and traces
- **Promtail / Node Exporter / cAdvisor**: Log and metric collectors

## Technology Stack

- **Host**: AlmaLinux 10
- **Infrastructure**:
  - Docker Engine + Docker Compose
  - Traefik v2.11 (reverse proxy with Let's Encrypt integration)
  - Portainer (container management)
- **Observability**:
  - Prometheus (metrics collection and alerting)
  - Grafana (dashboards and exploration)
  - Loki (log aggregation)
  - Tempo (distributed tracing)
  - Promtail, Node Exporter, cAdvisor (collectors)
- **Secrets Management**:
  - OpenBao vault (runtime source of truth)
  - SOPS + age (bootstrap and disaster-recovery backup)
  - AppRole authentication per stack
  - Auto-unseal via systemd on boot
- **Security**:
  - Tailscale VPN (admin access)
  - Let's Encrypt (automatic HTTPS)
  - IP whitelist middleware (Tailscale CGNAT range)
  - bcrypt (password hashing for Traefik auth)
- **DNS**: Hostinger DNS API (automated via `scripts/hostinger.sh`)
- **APIs**:
  - Hostinger VPS API (infrastructure automation)
  - Tailscale API (network management)

## Deployment

- **VPS Provisioning**: Hostinger API (automated via `scripts/vps.sh`)
- **Configuration as Code**: Ansible playbooks (VPS bootstrap)
- **Container Orchestration**: Docker Compose, three stacks
- **CI/CD**: GitHub Actions (CI, VPS lifecycle, per-stack deploy, Tailscale ACL sync)
- **DNS Management**: Automated via Hostinger DNS API (`scripts/hostinger.sh`)
- **Certificate Management**: Automatic via Let's Encrypt (HTTP-01 + DNS-01)

## See Also

- [Certificate Management](./certificates.md) - HTTP-01 vs DNS-01 challenges, DNS Manager implementation
- [Secrets Architecture](./secrets-model.md) - Vault-first architecture, KV paths, AppRole, sync
- [Security Architecture](./security.md)
- [Observability Runbook](../runbooks/observability.md) - LGTM stack operations, dashboards, alerts
- [Deployment Guide](../runbooks/deployment.md)
- [VPS Rebuild Runbook](../runbooks/vps-rebuild.md)
