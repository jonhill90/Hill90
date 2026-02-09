---
applyTo: ".github/workflows/**"
---

# GitHub Actions Workflow Guidance

When working with GitHub Actions workflow files:

- VPS recreate requires manual confirmation ("RECREATE" input)
- Config VPS auto-triggers after recreate, or can be triggered manually
- Deploy workflow uses PRODUCTION Let's Encrypt certificates by default
- Use Tailscale GitHub Action for SSH access to VPS
- Ephemeral runner nodes join Tailscale via OAuth credentials
- SSH to VPS uses Tailscale IP (not public IP)
- Always validate infrastructure before deployment
- Include health checks after deployment
- Required secrets: HOSTINGER_API_KEY, TAILSCALE_API_KEY, TS_OAUTH_CLIENT_ID, TS_OAUTH_SECRET, VPS_SSH_PRIVATE_KEY, SOPS_AGE_KEY
