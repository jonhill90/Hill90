---
paths:
  - infra/**
  - deployments/**
---

# Infrastructure Authoring Rules

When editing infrastructure files (Ansible, Terraform, Docker Compose, deployment configs):

## Principles

- All operations use Makefile commands — don't bypass with raw commands
- Ansible playbooks must be idempotent — safe to re-run
- Docker Compose files are per-service — don't combine into monolithic files
- Secrets are SOPS-encrypted — never commit plaintext secrets

## Deployment

- Infrastructure deploys before applications (creates Docker networks)
- Deployments run on VPS via SSH, never locally on Mac
- Use STAGING certificates for local testing, PRODUCTION via GitHub Actions

## Testing

- After infrastructure changes, verify with `make health`
- After Ansible changes, test by re-running `make config-vps`
- After deployment changes, test with per-service deploy commands

## Secrets

- Use `make secrets-view` / `make secrets-update` for safe operations
- Never use `sops -d` to temp files (leaves unencrypted data on disk)
- Age key is at `infra/secrets/keys/age-prod.key` (local) or `/opt/hill90/secrets/keys/keys.txt` (VPS)
