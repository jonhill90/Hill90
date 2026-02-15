---
description: 'Rules for editing GitHub Actions workflow files'
applyTo: '.github/workflows/**/*.yml'
---

# GitHub Actions Workflow Rules

When editing GitHub Actions workflow files:

## Principles

- Workflows use the hybrid approach: local Mac scripts AND GitHub Actions
- VPS recreate requires manual confirmation ("RECREATE" input)
- Config VPS auto-triggers deploy-infra after completion
- Deploy workflows use PRODUCTION certificates by default

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
- All deploy workflows must have `concurrency: group: deploy-prod`

## Harness Workflow Alignment

- Follow the required PR workflow in `AGENTS.md` and `.github/docs/contribution-workflow.md`.
- Expect CI + Copilot review as mandatory quality gates before merge.
- Keep workflow changes compatible with path-filtered post-merge deploy triggers.

## Certificate Management

- GitHub Actions: PRODUCTION Let's Encrypt (trusted, rate-limited)
- Local development: STAGING Let's Encrypt (untrusted, unlimited)
- Rate limits: 50 certs/week, 5 failures/hour

## Post-Deploy Verification

- Check containers are running (hard failure)
- Check Traefik logs for config errors (hard failure)
- Check TLS certificate issuers (warning — DNS-01 certs may take 2-5 min)
