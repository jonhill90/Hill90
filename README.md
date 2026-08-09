# Hill90

Homelab infrastructure for a single Hostinger VPS: provisioning, edge routing,
observability, and secrets — automated end to end.

Hill90 is not an application repository. It is the platform automation that takes
a bare VPS to a running, TLS-terminated, observable, Tailscale-secured Docker
host and keeps it there. The [`hill90-app`](https://github.com/jonhill90/hill90-app)
AI application runs on that host as a **tenant**, consuming this platform's identity,
database and object storage. What the platform offers a tenant, and what it does
not, is in [App tenancy on the VPS](docs/decisions/app-tenancy-on-the-vps.md).

## What runs

Sixteen long-running platform containers across six independently deployable units,
plus a one-shot `openbao-init` container that exits after initialization. Verified on
the production host `2026-08-09 03:53:04 UTC`: all 16 platform containers and all 7
tenant containers were running, and none of the 23 was unhealthy.

| Deploy unit | Containers | Deploy |
|---|---|---|
| Edge | traefik, portainer | `deploy.sh infra prod` |
| Database | postgres, postgres-exporter | `deploy.sh db prod` |
| Identity | keycloak | `deploy.sh auth prod` |
| Object storage | minio | `deploy.sh minio prod` |
| Secrets | openbao | `deploy.sh vault prod` |
| Observability | prometheus, grafana, loki, tempo, promtail, node-exporter, cadvisor, alertmanager, blackbox-exporter | `deploy.sh observability prod` |

| Service | URL | Access |
|---|---|---|
| Traefik | https://traefik.hill90.com | Tailscale only |
| Portainer | https://portainer.hill90.com | Tailscale only |
| Grafana | https://grafana.hill90.com | Tailscale only |
| MinIO | https://storage.hill90.com | Tailscale only |
| OpenBao | https://vault.hill90.com | Tailscale only |
| Keycloak | https://auth.hill90.com | Public sign-in surface |

Everything with a dashboard is Tailscale-only (`100.64.0.0/10`), enforced by a
Traefik IP-allowlist middleware. Only ports 80 and 443 are open publicly.

## Architecture

- **Host**: AlmaLinux 10 on a Hostinger VPS
- **Runtime**: Docker Engine + Docker Compose
- **Edge**: Traefik v2.11 with Let's Encrypt
  - **HTTP-01** for public hostnames
  - **DNS-01** via lego's built-in Cloudflare provider for Tailscale-only
    hostnames, whose A records point into the Tailscale range and so cannot be
    reached by an HTTP-01 validator
- **Identity**: one Keycloak, one live `platform` realm
- **Data**: platform Postgres, including the tenant's three databases under a
  dedicated non-superuser role
- **Object storage**: platform MinIO, consumed by the tenant
- **Observability**: Prometheus, Grafana, Loki, Tempo, Alertmanager and
  blackbox-exporter, plus Promtail, node-exporter and cAdvisor
- **Secrets**: OpenBao at runtime, SOPS/age for bootstrap and disaster recovery
- **Admin access**: Tailscale VPN, SSH key only
- **Provisioning**: Ansible playbooks, Hostinger API, Tailscale API
- **CI/CD**: GitHub Actions
- **DNS**: Cloudflare (zone `hill90.com`). Hostinger remains the VPS host and
  mail provider; `scripts/hostinger.sh` is VPS management

This repository contains no application code. DNS-01 issuance is configuration:
Traefik embeds lego, which talks to the Cloudflare API directly using
`CF_DNS_API_TOKEN`. The `services/dns-manager` shim that previously bridged to
the Hostinger DNS API was deleted when the zone moved to Cloudflare.

## Prerequisites

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (>= 2.15)
- [SOPS](https://github.com/getsops/sops) (>= 3.8)
- [age](https://github.com/FiloSottile/age) (>= 1.1)
- [Docker](https://docs.docker.com/get-docker/) (>= 24.0)
- [Tailscale](https://tailscale.com/download) — required for any VPS access

## Quick start

### Locally, on a Mac

```bash
git clone <repository-url>
cd Hill90
bash scripts/local.sh up
```

The compose configuration defines the same 16 long-running platform services and
the one-shot `openbao-init` service, with local overrides and throwaway credentials;
it never touches the VPS. Then open
http://grafana.localtest.me:8080/ (admin / admin).

It runs the **same compose files production uses** — differences live in
`.env.local` and `deploy/compose/overrides/local.*.yml`, and CI fails if the two
environments drift. Full guide: [Local development](docs/runbooks/local-development.md).

### On the VPS

```bash
brew install ansible sops age     # macOS
make secrets-init                 # generates age keypair + encrypted secrets
```

Deploys run **on the VPS over SSH**, never from a local Mac. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## VPS rebuild

A full rebuild takes roughly 6–9 minutes.

```bash
make snapshot                   # optional safety snapshot
make recreate-vps               # rebuild OS, rotate Tailscale key, update VPS_IP
make config-vps VPS_IP=<ip>     # deploy user, Docker, firewall, Tailscale, SOPS
```

Then, on the VPS:

```bash
bash scripts/deploy.sh infra prod
bash scripts/deploy.sh db prod
bash scripts/deploy.sh auth prod
bash scripts/deploy.sh minio prod
bash scripts/deploy.sh vault prod
bash scripts/deploy.sh observability prod
bash scripts/deploy.sh verify infra
bash scripts/deploy.sh verify db
bash scripts/deploy.sh verify auth
bash scripts/deploy.sh verify minio
bash scripts/deploy.sh verify vault
bash scripts/deploy.sh verify observability
```

**Why provisioning and deployment are separate:** Let's Encrypt limits
validation failures to five per hour. Requesting certificates during bootstrap
would exhaust that budget across repeated rebuild tests, so certificate-issuing
deploys are a deliberate second phase.

Full procedure: [VPS rebuild runbook](docs/runbooks/vps-rebuild.md).

## Commands

`make` targets are local convenience wrappers. On the VPS or in CI, use the
script form directly. The full mapping is in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
bash scripts/local.sh up    # the whole stack, locally

make deploy-infra           # Traefik, Portainer
make deploy-db              # PostgreSQL, postgres-exporter
make deploy-auth            # Keycloak (after database)
make deploy-minio           # Platform object storage
make deploy-vault           # OpenBao
make deploy-observability   # LGTM, alerting, probes + collectors

make health                 # health check
make ps                     # running containers
make logs-traefik           # follow one service
make validate               # Traefik config, secrets, compose

make backup                 # back up all critical volumes
make dns-verify             # verify DNS propagation
```

## Secrets

The deploy code is vault-first with SOPS fallback. SOPS/age also provides the
bootstrap and disaster-recovery store; OpenBao is the runtime secret service.
Do not infer which source served a deploy from that design alone — the evidence
and current credential gap are recorded in
[Secrets architecture](docs/architecture/secrets-model.md).

```bash
make secrets-view KEY=VPS_IP
make secrets-update KEY=VPS_IP VALUE="1.2.3.4"
make check-secrets-schema
```

```text
infra/secrets/
├── .sops.yaml          # SOPS configuration
├── prod.enc.env        # encrypted production secrets
└── keys/
    ├── age-prod.key    # private key (gitignored)
    └── age-prod.pub    # public key
```

`platform/vault/secrets-schema.yaml` is the canonical map of vault paths to SOPS
keys to compose `${VAR}` references, enforced on every pull request.

**Never commit decrypted secrets or private keys.**

Details: [Secrets architecture](docs/architecture/secrets-model.md) ·
[Secrets workflow](docs/runbooks/secrets-workflow.md)

## CI/CD

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | pull request | bats, pytest, shellcheck, compose validation, link and schema checks |
| `deploy.yml` | push to `main` | path-filtered deploy of changed stacks |
| `deploy-{infra,db,auth,minio,vault,observability}.yml` | manual | single-unit deploy |
| `recreate-vps.yml`, `config-vps.yml` | manual | VPS lifecycle |
| `vault-sync-to-sops.yml` | weekly + manual | sync vault back to the SOPS backup |
| `tailscale.yml` | `policy.hujson` change | sync Tailscale ACLs |

Required repository secrets: `TAILSCALE_API_KEY`, `TS_OAUTH_CLIENT_ID`,
`TS_OAUTH_SECRET`, `VPS_SSH_PRIVATE_KEY`, `SOPS_AGE_KEY`.

Setup guide: [GitHub Actions reference](docs/reference/github-actions.md).

## Monitoring

```bash
make health                 # scripted health check
make ps                     # container census
make logs-traefik           # follow a service
```

Grafana at https://grafana.hill90.com carries dashboards for Traefik, cAdvisor,
node-exporter and Loki logs.

Alertmanager delivers alerts by **email**, to the address in `ACME_EMAIL`, through the
SMTP account this estate already had. There are 29 rules in 10 groups; two central rules are
`PublicSiteDown` (hill90.com not answering) and `VaultSealedOrUnreachable`. Every
notification names the service, the host, and what to do first.

Delivery was **proven end to end** on 2026-07-31 — a real probe failure, a real email —
rather than assumed; that exercise found two defects a config check does not catch. Before
that date there was no receiver at all and every rule was inert, including one that fired
for 48 hours and reached nobody. The audit, the ranked gaps still open, and the evidence
are in [docs/decisions/alerting-audit.md](docs/decisions/alerting-audit.md).

Runbook: [Observability](docs/runbooks/observability.md).

## Security

**SSH** — the repository intends root login disabled, password authentication
disabled, key-based access, fail2ban, and reachability only over Tailscale. Do not
read intended configuration as proof of live state: [#786](https://github.com/jonhill90/Hill90/issues/786)
tracks measured drift in production's effective `PasswordAuthentication` setting.

**Network** — firewall allows 80/443 publicly and SSH from Tailscale only.
Internal Docker networks are `internal: true` and unreachable from outside.

**TLS** — certificates renew automatically via Let's Encrypt: HTTP-01 for public
hostnames, DNS-01 for Tailscale-only ones. Security headers are enforced at
Traefik, and the Traefik dashboard password hash comes from encrypted secrets.

**Vault** — administrative access is token-based and services use AppRole. OpenBao
has no OIDC auth method enabled; the platform Keycloak remains live and serves other
platform and tenant clients. See
[Secrets architecture](docs/architecture/secrets-model.md).

## Troubleshooting

```bash
# VPS reachable?
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com 'uptime'

# Service state
docker ps
docker compose -p hill90-prod-edge -f deploy/compose/prod/docker-compose.infra.yml ps
docker logs -f traefik

# Certificates
docker logs traefik 2>&1 | grep -i acme
openssl s_client -connect grafana.hill90.com:443 -servername grafana.hill90.com </dev/null 2>/dev/null | openssl x509 -noout -dates

# Secrets
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key sops -d infra/secrets/prod.enc.env >/dev/null && echo OK

# DNS
make dns-view
make dns-verify
make dns-sync            # after a rebuild changes the IP
```

**DNS-01 failures** are usually the `CF_DNS_API_TOKEN` being absent, empty or
under-scoped (it needs Zone/Zone/Read *and* Zone/DNS/Edit on `hill90.com`), the
zone not yet being authoritative, or Let's Encrypt rate limiting. Read the
Traefik log — there is no separate DNS container, and Traefik stays healthy
through a failed renewal.

Full guide: [Troubleshooting](docs/runbooks/troubleshooting.md).

## Documentation

**Start here**
- [Contributing](CONTRIBUTING.md) — workflow, command map, operational guardrails
- [VPS rebuild](docs/runbooks/vps-rebuild.md) — full rebuild procedure

**Architecture**
- [Overview](docs/architecture/overview.md)
- [Certificates](docs/architecture/certificates.md) — HTTP-01 vs DNS-01
- [Secrets model](docs/architecture/secrets-model.md)
- [Security](docs/architecture/security.md)

**Runbooks**
- [Local development](docs/runbooks/local-development.md)
- [Bootstrap](docs/runbooks/bootstrap.md)
- [Deployment](docs/runbooks/deployment.md)
- [Disaster recovery](docs/runbooks/disaster-recovery.md)
- [DNS cutover](docs/runbooks/dns-cutover.md) — Hostinger to Cloudflare, mail-preserving
- [Observability](docs/runbooks/observability.md)
- [Secrets workflow](docs/runbooks/secrets-workflow.md)
- [Vault unseal](docs/runbooks/vault-unseal.md)
- [Troubleshooting](docs/runbooks/troubleshooting.md)

**Reference**
- [Deployment architecture](docs/reference/deployment.md)
- [GitHub Actions](docs/reference/github-actions.md)
- [VPS operations](docs/reference/vps-operations.md)
- [DNS](docs/reference/dns.md)
- [Secrets](docs/reference/secrets.md)
- [Tailscale](docs/reference/tailscale.md)

## License

MIT
