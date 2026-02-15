---
description: 'Rules for editing infrastructure, deployment, and platform configuration files'
applyTo:
  - 'infra/**'
  - 'deploy/**'
  - 'platform/**'
  - 'scripts/**'
---

# Infrastructure Rules

When editing infrastructure files (Ansible, Docker Compose, Traefik, deployment configs, scripts):

## Principles

- All operations use Makefile commands — don't bypass with raw commands
- Ansible playbooks must be idempotent — safe to re-run
- Docker Compose files are per-service — don't combine into monolithic files
- Secrets are SOPS-encrypted — never commit plaintext secrets

## Traefik Configuration

- Traefik does NOT interpolate `${VAR}` in YAML config files — hardcode values
- `caServer` is set via Docker Compose CLI args (Compose does interpolate)
- `letsencrypt` resolver = HTTP-01 (public services)
- `letsencrypt-dns` resolver = DNS-01 (Tailscale-only services)
- `tailscale-only` middleware restricts access to CGNAT range (100.64.0.0/10)
- Auth middleware uses `usersFile`, not inline `users`

## Deployment

- Infrastructure deploys before applications (creates Docker networks)
- Deployments run on VPS via SSH, never locally on Mac
- Use STAGING certificates for local testing, PRODUCTION via GitHub Actions
- All deploy workflows share `concurrency: group: deploy-prod` for serialization

## Testing

- After infrastructure changes, verify with `make health`
- After Traefik changes, run `bash scripts/validate.sh traefik`
- After script changes, run `bats tests/scripts/` and `shellcheck --severity=error scripts/*.sh`
- After deployment changes, test with per-service deploy commands

## Secrets

- Use `make secrets-view` / `make secrets-update` for safe operations
- Never use `sops -d` to temp files (leaves unencrypted data on disk)
- Age key: `infra/secrets/keys/age-prod.key` (local) or `/opt/hill90/secrets/keys/keys.txt` (VPS)
