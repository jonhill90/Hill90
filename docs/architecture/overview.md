# Hill90 Architecture Overview

*This document describes the high-level architecture of the Hill90 VPS platform.*

## System Architecture

Hill90 is a Docker-based microservices platform hosted on a single Hostinger VPS running AlmaLinux.

### Components

- **Edge Layer**: Traefik reverse proxy with automatic HTTPS
- **Application Layer**: Microservices (API, AI, MCP, Auth, UI)
- **Data Layer**: PostgreSQL database
- **Infrastructure**: Docker Compose orchestration

### Network Topology

```
Internet
   ↓
Traefik (edge network)
   ↓
┌─────────────────────────────┐
│ Public Services (edge)      │
│ - API                       │
│ - AI                        │
│ - MCP (authenticated)       │
│ - UI                        │
└─────────────────────────────┘
   ↓
┌─────────────────────────────┐
│ Internal Services (internal)│
│ - Auth                      │
│ - PostgreSQL                │
└─────────────────────────────┘
```

## Service Responsibilities

- **API**: REST API gateway, orchestrates requests
- **AI**: LangChain/LangGraph agents, AI operations
- **MCP**: Model Context Protocol gateway (authenticated)
- **Auth**: JWT-based authentication
- **UI**: Next.js frontend

## Technology Stack

- **Languages**: TypeScript (Node.js), Python
- **Frameworks**: Express, FastAPI, Next.js
- **Infrastructure**: Docker, Traefik, PostgreSQL
- **Security**: SOPS, age, Tailscale, Let's Encrypt

## Deployment

- **IaC**: Terraform (VPS provisioning)
- **CaC**: Ansible (VPS bootstrap)
- **Orchestration**: Docker Compose
- **CI/CD**: GitHub Actions

## See Also

- [Security Architecture](./security.md)
- [Networking](./networking.md)
- [Deployment Guide](../runbooks/deployment.md)
