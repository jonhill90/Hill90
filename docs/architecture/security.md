# Security Architecture

Hill90 uses layered controls to keep public services reachable while restricting administration and service-to-service paths.

## Access Boundaries

- Public internet access is limited to HTTP/HTTPS entrypoints handled by Traefik.
- Administrative surfaces (Traefik dashboard and Portainer) are reachable only through Tailscale.
- SSH access is restricted to the Tailscale CIDR (`100.64.0.0/10`) via firewall rules.

## Identity And Secrets

- SSH uses key-based authentication only; password auth and root login are disabled.
- Runtime secrets are stored in `infra/secrets/prod.enc.env` and encrypted with SOPS + age.
- Secrets are decrypted only at deploy/runtime (`sops exec-env`) and not committed in plaintext.

## Network Segmentation

- `hill90_edge`: ingress-facing network for Traefik and public app routes.
- `hill90_internal`: internal-only network for private service communication.
- Tailscale-only routes are protected with Traefik middleware and IP allowlists.

## TLS And Certificate Controls

- Public services use Let's Encrypt HTTP-01.
- Tailscale-only services use Let's Encrypt DNS-01 via `dns-manager` and Hostinger DNS API.
- ACME state is persisted in mounted Traefik storage for renewal continuity.

## Operational Hardening

- Host firewall allows 80/443 publicly and blocks public SSH.
- Deploy/rebuild actions run through scripted workflows (`make` + `scripts/*.sh`) to reduce manual drift.
- DNS and infrastructure reconciliation are automated during VPS rebuild/bootstrap.

## Verification Checklist

- `make health` passes after deploy.
- `ssh deploy@<public-ip>` fails while `ssh deploy@<tailscale-ip>` succeeds.
- `make dns-verify` confirms expected A/TXT propagation.
- Traefik logs show successful ACME issuance/renewal.
