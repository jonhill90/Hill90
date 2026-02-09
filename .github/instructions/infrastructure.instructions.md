---
applyTo: "infra/**,deployments/**"
---

# Infrastructure Guidance

When working with infrastructure files:

- All operations use Makefile commands for consistency
- Ansible playbooks must be idempotent (safe to re-run)
- Docker Compose files are per-service (not monolithic)
- Secrets are SOPS-encrypted with age — never commit plaintext
- Infrastructure deploys before applications (creates Docker networks)
- Deployments run on VPS via SSH, never locally
- Use STAGING certificates for local testing, PRODUCTION via GitHub Actions
- After changes, verify with `make health`
