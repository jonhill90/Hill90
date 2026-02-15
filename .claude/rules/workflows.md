---
paths:
  - .github/workflows/**
---

# GitHub Actions Workflow Rules

When editing GitHub Actions workflow files:

## Principles

- Workflows use the hybrid approach: local Mac scripts AND GitHub Actions
- VPS recreate requires manual confirmation ("RECREATE" input)
- Config VPS auto-triggers after recreate — can also be triggered manually
- Deploy workflow uses PRODUCTION certificates by default

## Required Secrets

All workflows depend on these GitHub repository secrets:
- `HOSTINGER_API_KEY` — VPS management API
- `TAILSCALE_API_KEY` — Device/key management API
- `TS_OAUTH_CLIENT_ID` — GitHub runner network access
- `TS_OAUTH_SECRET` — GitHub runner network access
- `VPS_SSH_PRIVATE_KEY` — SSH access to VPS
- `SOPS_AGE_KEY` — Secrets decryption

## Patterns

- Use Tailscale GitHub Action for SSH access to VPS
- Ephemeral runner nodes join Tailscale network via OAuth
- SSH to VPS uses Tailscale IP, not public IP
- Always validate infrastructure before deployment
- Include health checks after deployment

## Harness Workflow Alignment

- Follow the required PR workflow in `AGENTS.md` and `.github/docs/contribution-workflow.md`.
- Treat CI and automated review as release gates before merge.
- Preserve post-merge deploy trigger behavior when editing workflow paths and filters.

## Certificate Management

- GitHub Actions: PRODUCTION Let's Encrypt (trusted, rate-limited)
- Local development: STAGING Let's Encrypt (untrusted, unlimited)
- Rate limits: 50 certs/week, 5 failures/hour
