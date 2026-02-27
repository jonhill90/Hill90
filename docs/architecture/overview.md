# Hill90 Architecture Overview

*This document describes the high-level architecture of the Hill90 VPS platform.*

## System Architecture

Hill90 is a Docker-based microservices platform hosted on a single Hostinger VPS running AlmaLinux.

### Components

- **Edge Layer**: Traefik reverse proxy with automatic HTTPS (dual certificate resolvers)
- **Application Layer**: Microservices (API, AI, MCP, Knowledge, UI) with Keycloak identity provider
- **Data Layer**: PostgreSQL database, MinIO S3-compatible object storage
- **Observability Layer**: LGTM stack (Loki, Grafana, Tempo, Prometheus) with collectors and exporters
- **Infrastructure Layer**:
  - Docker Compose orchestration
  - DNS Manager (Let's Encrypt DNS-01 challenge webhook)
  - Portainer (container management UI)
  - Tailscale VPN (secure admin access)

### Network Topology

```
Internet                         Tailscale Network (100.64.0.0/10)
   ↓                                     ↓
Traefik (edge network)           ┌──────────────────────────┐
   ↓                             │ Admin Services           │
┌─────────────────────────────┐  │ - Traefik Dashboard      │
│ Public Services (edge)      │  │ - Portainer UI           │
│ - API (HTTP-01 cert)        │  └──────────────────────────┘
│ - AI (HTTP-01 cert)         │           ↓ (DNS-01 certs)
│ - MCP (HTTP-01, auth)       │           ↓
│ - Keycloak (HTTP-01 cert)   │  ┌──────────────────────────┐
│ - UI (HTTP-01 cert)         │  │ DNS Manager              │
└─────────────────────────────┘  │ (Webhook for ACME)       │
   ↓                             └──────────────────────────┘
┌─────────────────────────────┐           ↓
│ Internal Services (internal)│  Hostinger DNS API
│ - PostgreSQL                │  (TXT record management)
│ - MinIO (S3 API)            │
│ - postgres-exporter         │
└─────────────────────────────┘
   ↓
┌─────────────────────────────┐
│ Observability (internal)    │  ┌──────────────────────────┐
│ - Prometheus (metrics)      │  │ Grafana Dashboard        │
│ - Loki (logs)               │  │ (grafana.hill90.com,     │
│ - Tempo (traces)            │  │  Tailscale-only)         │
│ - Promtail (log collector)  │  └──────────────────────────┘
│ - Node Exporter (host)      │
│ - cAdvisor (containers)     │
└─────────────────────────────┘
```

**Certificate Management:**
- **Public services** use HTTP-01 challenge (Let's Encrypt validates via port 80)
- **Tailscale-only services** use DNS-01 challenge (Let's Encrypt validates via DNS TXT records)
- DNS Manager translates Traefik ACME requests to Hostinger DNS API calls

**Network Isolation:**
- **edge network**: Public-facing services (Traefik → API, AI, MCP, Keycloak, UI)
- **internal network**: Private services (Keycloak, PostgreSQL, AKM, observability stack)
- **agent_internal network**: Agent containers ↔ API ↔ AKM (isolated from edge)
- **Tailscale network**: Admin-only services (Traefik dashboard, Portainer, MinIO console, Grafana)
- **IP Whitelist**: 100.64.0.0/10 (Tailscale CGNAT range) via middleware

## Service Responsibilities

### Application Services

- **API**: REST API gateway, orchestrates requests
- **AI**: LangChain/LangGraph agents, AI operations
- **MCP**: Model Context Protocol gateway (Keycloak JWT authenticated)
- **Keycloak**: Identity provider (OIDC/OAuth2) at auth.hill90.com
- **UI**: Next.js frontend application
- **Knowledge (AKM)**: Agent Knowledge Manager — persistent knowledge store for agents (Ed25519 JWT auth, FTS, CLI)

### Infrastructure Services

- **Traefik**: Reverse proxy, load balancer, automatic HTTPS
  - HTTP-01 challenge for public services
  - DNS-01 challenge for Tailscale-only services
  - Dashboard accessible at https://traefik.hill90.com (Tailscale-only)
- **Portainer**: Docker container management UI at https://portainer.hill90.com (Tailscale-only)
- **MinIO**: S3-compatible object storage, console at https://storage.hill90.com (Tailscale-only), S3 API internal-only on `hill90_internal`
- **DNS Manager**: HTTP webhook for Let's Encrypt DNS-01 challenges
  - Translates Lego httpreq provider format to Hostinger DNS API
  - Creates/deletes DNS TXT records for ACME validation
- **PostgreSQL**: Relational database for persistent storage (separate deploy: `make deploy-db`)

## Technology Stack

- **Languages**: TypeScript (Node.js), Python
- **Frameworks**: Express, FastAPI, Next.js
- **Infrastructure**:
  - Docker Engine + Docker Compose
  - Traefik (reverse proxy with Let's Encrypt integration)
  - Portainer (container management)
  - PostgreSQL
  - MinIO (S3-compatible object storage)
- **Observability**:
  - Prometheus (metrics collection and alerting)
  - Grafana (dashboards and exploration)
  - Loki (log aggregation)
  - Tempo (distributed tracing)
  - OpenTelemetry (application tracing instrumentation)
  - Promtail, Node Exporter, cAdvisor, postgres-exporter (collectors)
- **Secrets Management**:
  - OpenBao vault (runtime source of truth)
  - SOPS + age (bootstrap and disaster-recovery backup)
  - AppRole authentication per service
  - Auto-unseal via systemd on boot
- **Security**:
  - Tailscale VPN (admin access)
  - Let's Encrypt (automatic HTTPS)
  - IP whitelist middleware (Tailscale CGNAT range)
  - bcrypt (password hashing for Traefik auth)
  - Keycloak 26.4 (identity provider, OIDC/OAuth2)
  - Auth.js v5 (session management)
- **DNS**: Hostinger DNS API (automated via MCP tools)
- **APIs**:
  - Hostinger VPS API (infrastructure automation)
  - Tailscale API (network management)

## Deployment

- **VPS Provisioning**: Hostinger API (fully automated via Makefile)
- **Configuration as Code**: Ansible playbooks (VPS bootstrap)
- **Container Orchestration**: Docker Compose
- **CI/CD**: GitHub Actions (CI, VPS lifecycle, per-service deploy, and Tailscale ACL workflows)
- **DNS Management**: Automated via Hostinger DNS API (MCP tools)
- **Certificate Management**: Automatic via Let's Encrypt (HTTP-01 + DNS-01)

## See Also

- [Certificate Management](./certificates.md) - HTTP-01 vs DNS-01 challenges, DNS Manager implementation
- [Secrets Architecture](./secrets-model.md) - Vault-first architecture, KV paths, AppRole, sync
- [Security Architecture](./security.md)
- [Observability Runbook](../runbooks/observability.md) - LGTM stack operations, dashboards, alerts
- [Deployment Guide](../runbooks/deployment.md)
- [VPS Rebuild Runbook](../runbooks/vps-rebuild.md)
