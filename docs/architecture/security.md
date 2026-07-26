# Security Architecture

Hill90 uses layered controls to keep a small public surface reachable while
restricting administration to a private network.

## Access Boundaries

- Public internet access is limited to the HTTP/HTTPS entrypoints handled by
  Traefik. Only ports 80 and 443 are open on the host firewall.
- Every administrative surface — the Traefik dashboard, Portainer, Grafana and
  the OpenBao UI — is reachable only through Tailscale.
- SSH access is restricted to the Tailscale CIDR (`100.64.0.0/10`) via firewall
  rules.

## Identity And Secrets

- SSH uses key-based authentication only; password auth and root login are disabled.
- **OpenBao vault is the runtime source of truth for secrets.** SOPS + age serves as bootstrap and disaster-recovery backup. Deploy is vault-first with SOPS fallback, so a sealed or absent vault degrades to the encrypted file rather than failing.
- Each stack authenticates to vault via AppRole and reads only its assigned KV paths.
- Vault auto-unseals on boot via a systemd oneshot service; the unseal key is stored on the host at `/opt/hill90/secrets/openbao-unseal.key` with 0600 permissions.
- SOPS-encrypted secrets (`infra/secrets/prod.enc.env`) are decrypted only at deploy/runtime and not committed in plaintext.
- Vault-to-SOPS sync runs weekly via GitHub Actions to keep the SOPS backup current.
- See [Secrets Architecture](./secrets-model.md) for the full vault model.

## Admin Authentication

**Vault admin access is token-based. There is no single sign-on.**

OIDC through Keycloak was removed along with the Keycloak stack — the
`hill90-vault` client was its only remaining consumer, and carrying a full
identity provider for one operator was not worth the surface. Obtain a token
from `vault.sh init` output or `bao operator generate-root`, and revoke
generated root tokens immediately after use.

The Traefik dashboard and Portainer are protected by Traefik basic auth plus the
Tailscale IP allowlist. The dashboard password hash is generated at deploy time
from encrypted secrets into a gitignored `.htpasswd`.

## Email / SMTP

No service in the current stack sends email. Keycloak was the only sender;
`SMTP_PASSWORD` was removed with it.

## Network Segmentation

- `hill90_edge`: ingress-facing network for Traefik and the routed services.
- `hill90_internal`: `internal: true`, unreachable from outside the host; used for private service-to-service traffic.
- `hill90_agent_internal`: `internal: true`, created by the edge stack. Retained from the shelved application and currently unused by any running container.
- Tailscale-only routes are protected with Traefik middleware and IP allowlists in addition to the firewall.

`docker-compose.infra.yml` is the sole owner of all three networks; the
observability and vault stacks attach to them as external.

## TLS And Certificate Controls

- Public services use Let's Encrypt HTTP-01.
- Tailscale-only services use Let's Encrypt DNS-01 via `dns-manager` and the Hostinger DNS API — they have no public A record, so HTTP-01 cannot validate them.
- ACME state is persisted in mounted Traefik storage for renewal continuity.
- Security headers are applied by a shared Traefik middleware.

## Operational Hardening

- Host firewall allows 80/443 publicly and blocks public SSH; fail2ban is enabled.
- Deploy/rebuild actions run through scripted workflows (`make` + `scripts/*.sh`) to reduce manual drift.
- Deploys run on the VPS over SSH, never from a workstation.
- DNS and infrastructure reconciliation are automated during VPS rebuild/bootstrap.
- CI blocks destructive Docker commands (`down -v`, `volume rm`, `system prune`) from entering scripts or workflows.

## Verification Checklist

- `make health` passes after deploy.
- `ssh deploy@<public-ip>` fails while `ssh deploy@<tailscale-ip>` succeeds.
- `make dns-verify` confirms expected A/TXT propagation.
- Traefik logs show successful ACME issuance/renewal.
- `docker ps` shows the expected ten containers.

## See Also

- [Architecture overview](./overview.md)
- [Secrets model](./secrets-model.md)
- [Certificate management](./certificates.md)
