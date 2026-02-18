# Deployment Runbook

Standard deployment process for Hill90 on the Hostinger VPS.

## Prerequisites

- Access to the VPS over Tailscale (`remote.hill90.com` or `<tailscale-ip>`).
- Age key present on VPS at `/opt/hill90/secrets/keys/keys.txt`.
- Encrypted secrets file available in repo (`infra/secrets/prod.enc.env`).

## Deploy Infrastructure

```bash
make deploy-infra
```

Expected outcome:
- `traefik`, `dns-manager`, and `portainer` containers are healthy.
- `hill90_edge` and `hill90_internal` Docker networks exist.
- DNS-01 certificate flow is functional for Tailscale-only routes.

## Deploy Database

```bash
make deploy-db
```

Expected outcome:
- `postgres` container is healthy on the internal network.
- Required before `make deploy-all` (Keycloak depends on PostgreSQL).

## Deploy Storage (Optional)

```bash
make deploy-minio
```

Expected outcome:
- `minio` container is healthy on edge and internal networks.
- S3 API available at `http://minio:9000` from internal containers.
- Console at `https://storage.hill90.com` (Tailscale-only).

## Deploy Observability

```bash
bash scripts/deploy.sh observability prod   # canonical (VPS/CI)
make deploy-observability                    # convenience (local Mac)
```

Expected outcome:
- 7 containers healthy: `prometheus`, `grafana`, `loki`, `tempo`, `promtail`, `node-exporter`, `cadvisor`.
- Grafana accessible at `https://grafana.hill90.com` (Tailscale-only).
- Prometheus scrape targets all show `up`.

## Deploy Application Services

```bash
make deploy-all
```

Expected outcome:
- `keycloak`, `api`, `ai`, `mcp`, `ui` are running.
- Public routes respond through Traefik with valid certificates.

## Validate Deployment

```bash
make health
make dns-verify
```

Optional targeted checks:

```bash
make logs-traefik
curl -f https://api.hill90.com/health
curl -f https://ai.hill90.com/health
curl -f https://auth.hill90.com/realms/hill90/.well-known/openid-configuration

# MinIO console (Tailscale-only):
curl -f https://storage.hill90.com
```

## SSH-Based Deployment (On VPS)

```bash
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh infra prod && bash scripts/deploy.sh db prod && bash scripts/deploy.sh minio prod && bash scripts/deploy.sh observability prod && bash scripts/deploy.sh all prod'
```

## Rollback Guidance

- If a service deploy fails, redeploy the last known good compose revision and rerun `make health`.
- If infrastructure is unstable, rerun `make deploy-infra` before app redeploy.
- For catastrophic failure, use the VPS rebuild flow in `docs/runbooks/vps-rebuild.md`.

## Failure Modes

- Missing or invalid secrets: `sops`/runtime env errors at deploy time.
- Missing Docker networks: app deploy fails until `make deploy-infra` recreates them.
- ACME rate limiting: switch to staged testing cadence and retry after cooldown.
