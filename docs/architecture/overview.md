# Hill90 Architecture Overview

*This document describes the high-level architecture of the Hill90 VPS platform.*

## System Architecture

Hill90 is a Docker-based microservices platform hosted on a single Hostinger VPS running AlmaLinux.

### Components

- **Edge Layer**: Traefik reverse proxy with automatic HTTPS (dual certificate resolvers)
- **Application Layer**: Microservices (API, AI, MCP, Auth, UI)
- **Data Layer**: PostgreSQL database
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
│ - UI (HTTP-01 cert)         │  ┌──────────────────────────┐
└─────────────────────────────┘  │ DNS Manager              │
   ↓                             │ (Webhook for ACME)       │
┌─────────────────────────────┐  └──────────────────────────┘
│ Internal Services (internal)│           ↓
│ - Auth                      │  Hostinger DNS API
│ - PostgreSQL                │  (TXT record management)
└─────────────────────────────┘
```

**Certificate Management:**
- **Public services** use HTTP-01 challenge (Let's Encrypt validates via port 80)
- **Tailscale-only services** use DNS-01 challenge (Let's Encrypt validates via DNS TXT records)
- DNS Manager translates Traefik ACME requests to Hostinger DNS API calls

**Network Isolation:**
- **edge network**: Public-facing services (Traefik → API, AI, MCP, UI)
- **internal network**: Private services (Auth, PostgreSQL)
- **Tailscale network**: Admin-only services (Traefik dashboard, Portainer)
- **IP Whitelist**: 100.64.0.0/10 (Tailscale CGNAT range) via middleware

## Service Responsibilities

### Application Services

- **API**: REST API gateway, orchestrates requests
- **AI**: LangChain/LangGraph agents, AI operations
- **MCP**: Model Context Protocol gateway (JWT authenticated)
- **Auth**: JWT-based authentication service
- **UI**: Next.js frontend application

### Infrastructure Services

- **Traefik**: Reverse proxy, load balancer, automatic HTTPS
  - HTTP-01 challenge for public services
  - DNS-01 challenge for Tailscale-only services
  - Dashboard accessible at https://traefik.hill90.com (Tailscale-only)
- **Portainer**: Docker container management UI at https://portainer.hill90.com (Tailscale-only)
- **DNS Manager**: HTTP webhook for Let's Encrypt DNS-01 challenges
  - Translates Lego httpreq provider format to Hostinger DNS API
  - Creates/deletes DNS TXT records for ACME validation
- **PostgreSQL**: Relational database for persistent storage

## Technology Stack

- **Languages**: TypeScript (Node.js), Python
- **Frameworks**: Express, FastAPI, Next.js
- **Infrastructure**:
  - Docker Engine + Docker Compose
  - Traefik (reverse proxy with Let's Encrypt integration)
  - Portainer (container management)
  - PostgreSQL
- **Security**:
  - SOPS + age (secrets encryption)
  - Tailscale VPN (admin access)
  - Let's Encrypt (automatic HTTPS)
  - IP whitelist middleware (Tailscale CGNAT range)
  - bcrypt (password hashing for Traefik auth)
- **DNS**: Hostinger DNS API (automated via MCP tools)
- **APIs**:
  - Hostinger VPS API (infrastructure automation)
  - Tailscale API (network management)

## Deployment

- **VPS Provisioning**: Hostinger API (fully automated via Makefile)
- **Configuration as Code**: Ansible playbooks (VPS bootstrap)
- **Container Orchestration**: Docker Compose
- **CI/CD**: GitHub Actions (4 workflows)
  - VPS Recreate - OS rebuild via Hostinger API
  - Config VPS - Infrastructure bootstrap via Ansible
  - Deploy - Application service deployment
  - Tailscale ACL - GitOps for network access control
- **DNS Management**: Automated via Hostinger DNS API (MCP tools)
- **Certificate Management**: Automatic via Let's Encrypt (HTTP-01 + DNS-01)

## See Also

- [Certificate Management](./certificates.md) - HTTP-01 vs DNS-01 challenges, DNS Manager implementation
- [Security Architecture](./security.md)
- [Deployment Guide](../runbooks/deployment.md)
- [VPS Rebuild Runbook](../runbooks/vps-rebuild.md)
