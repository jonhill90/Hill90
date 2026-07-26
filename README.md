# Hill90

Homelab infrastructure for a single Hostinger VPS: provisioning, edge routing,
observability, and secrets — automated end to end.

Hill90 is not an application host. It is the automation that takes a bare VPS to
a running, TLS-terminated, observable, Tailscale-secured Docker host, and keeps
it there. An AI agent application previously lived here; it was shelved in June
2026 and removed in July 2026. See
[Infra/app separation](docs/decisions/infra-app-separation.md) for the record,
and the `archive/app-stack-final` tag for the code.

## What runs

Ten containers across three stacks.

| Stack | Containers | Deploy |
|---|---|---|
| Edge | traefik, dns-manager, portainer | `deploy.sh infra prod` |
| Observability | prometheus, grafana, loki, tempo, promtail, node-exporter, cadvisor | `deploy.sh observability prod` |
| Secrets | openbao | `deploy.sh vault prod` |

| Service | URL | Access |
|---|---|---|
| Traefik | https://traefik.hill90.com | Tailscale only |
| Portainer | https://portainer.hill90.com | Tailscale only |
| Grafana | https://grafana.hill90.com | Tailscale only |
| OpenBao | https://vault.hill90.com | Tailscale only |
| dns-manager | internal | Traefik only |

Everything with a dashboard is Tailscale-only (`100.64.0.0/10`), enforced by a
Traefik IP-allowlist middleware. Only ports 80 and 443 are open publicly.

## Architecture

- **Host**: AlmaLinux 10 on a Hostinger VPS
- **Runtime**: Docker Engine + Docker Compose
- **Edge**: Traefik v2.11 with Let's Encrypt
  - **HTTP-01** for public hostnames
  - **DNS-01** via the `dns-manager` webhook for Tailscale-only hostnames, which
    have no public A record to validate against
- **Observability**: Prometheus, Grafana, Loki, Tempo, plus Promtail,
  node-exporter and cAdvisor
- **Secrets**: OpenBao at runtime, SOPS/age for bootstrap and disaster recovery
- **Admin access**: Tailscale VPN, SSH key only
- **Provisioning**: Ansible playbooks, Hostinger API, Tailscale API
- **CI/CD**: GitHub Actions
- **DNS**: Hostinger DNS API via `scripts/hostinger.sh`

`services/dns-manager` is the only application code in this repository — a small
Flask webhook implementing Traefik's `httpreq` DNS-01 provider against the
Hostinger API. Without it, certificates for Tailscale-only hosts cannot issue.

## Prerequisites

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (>= 2.15)
- [SOPS](https://github.com/getsops/sops) (>= 3.8)
- [age](https://github.com/FiloSottile/age) (>= 1.1)
- [Docker](https://docs.docker.com/get-docker/) (>= 24.0)
- [Tailscale](https://tailscale.com/download) — required for any VPS access

## Quick start

```bash
git clone <repository-url>
cd Hill90
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
bash scripts/deploy.sh vault prod
bash scripts/deploy.sh observability prod
bash scripts/deploy.sh verify infra
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
make deploy-infra           # Traefik, dns-manager, Portainer
make deploy-vault           # OpenBao
make deploy-observability   # Prometheus, Grafana, Loki, Tempo + collectors

make health                 # health check
make ps                     # running containers
make logs-traefik           # follow one service
make validate               # Traefik config, secrets, compose

make backup                 # back up all critical volumes
make dns-verify             # verify DNS propagation
```

## Secrets

OpenBao is the runtime source of truth; SOPS/age is the bootstrap and
disaster-recovery backup. Deploy is vault-first with SOPS fallback.

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
| `deploy-{infra,vault,observability}.yml` | manual | single-stack deploy |
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
node-exporter and Loki logs. Prometheus alerts cover service availability, memory
and disk.

Runbook: [Observability](docs/runbooks/observability.md).

## Security

**SSH** — root login disabled, password authentication disabled, key-based only,
fail2ban enabled, reachable only over Tailscale.

**Network** — firewall allows 80/443 publicly and SSH from Tailscale only.
Internal Docker networks are `internal: true` and unreachable from outside.

**TLS** — certificates renew automatically via Let's Encrypt: HTTP-01 for public
hostnames, DNS-01 for Tailscale-only ones. Security headers are enforced at
Traefik, and the Traefik dashboard password hash comes from encrypted secrets.

**Vault** — access is token-based. There is no SSO; OIDC through Keycloak was
removed with the Keycloak stack. See
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
docker logs dns-manager
openssl s_client -connect grafana.hill90.com:443 -servername grafana.hill90.com </dev/null 2>/dev/null | openssl x509 -noout -dates

# Secrets
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key sops -d infra/secrets/prod.enc.env >/dev/null && echo OK

# DNS
make dns-view
make dns-verify
make dns-sync            # after a rebuild changes the IP
```

**DNS-01 failures** are usually one of three things: `dns-manager` computing the
wrong TXT value (it must be `base64url(SHA256(keyAuth))`), a timeout during
`/present`, or Let's Encrypt rate limiting — wait an hour and test against the
staging CA.

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
- [Bootstrap](docs/runbooks/bootstrap.md)
- [Deployment](docs/runbooks/deployment.md)
- [Disaster recovery](docs/runbooks/disaster-recovery.md)
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
