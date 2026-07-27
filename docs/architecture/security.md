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

- SSH uses key-based authentication only; password auth and root login are
  disabled. This is set in `/etc/ssh/sshd_config.d/00-hill90-hardening.conf`,
  **not** in `sshd_config`. The name matters: sshd takes the first value it sees
  for a keyword, drop-ins are read in lexical order at the `Include` near the top
  of `sshd_config`, and cloud images ship a `50-cloud-init.conf` that enables
  password authentication. A setting written into `sshd_config` itself is read
  too late and has no effect — which is what this repository did until #539.
  - Verify the **effective** configuration rather than the files:
    `sudo bash scripts/verify-ssh-hardening.sh`, or `sudo sshd -T`. The
    bootstrap play asserts the same values and fails if they disagree.
  - **Not yet applied to the running host.** The fix ships in the playbook;
    until `make config-vps` runs, `sshd -T` still reports
    `passwordauthentication yes`. Exposure is bounded — see below.
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
- Tailscale-only routes are protected with Traefik middleware and IP allowlists in addition to the firewall. That control depends on Traefik seeing the true client address — see [Network-Layer Client Identity](#network-layer-client-identity).

`docker-compose.infra.yml` is the sole owner of all three networks; the
observability and vault stacks attach to them as external.

## Network-Layer Client Identity

The `tailscale-only` middleware is an `ipWhiteList` on `100.64.0.0/10`. It is only
a real control if Traefik sees the address the request actually came from. Until
2026-07-27 it did not, and the allowlist had to carry the Docker bridge gateway
`172.18.0.1/32` for tailnet access to work at all — an entry that cannot
distinguish on-network from off-network traffic, which is the middleware's whole
job.

Two independent mechanisms rewrote the source address to that same gateway. Both
are fixed; the reasoning is recorded here because the failure mode is invisible
in normal operation and easy to reintroduce.

### Tailscale masqueraded forwarded tailnet traffic

Tailscale installs two netfilter rules. Anything **forwarded** from `tailscale0`
is marked, and anything carrying that mark is masqueraded on the way out:

```
chain ts-forward     { iifname "tailscale0" ... meta mark set mark and 0xff00ffff xor 0x40000 }
chain ts-postrouting { meta mark & 0x00ff0000 == 0x00040000 ... masquerade }
```

Docker's DNAT was working correctly, and that is what triggered it. A tailnet
request to the host's Tailscale address is destined to a *local* address, so
`PREROUTING` sends it to the `DOCKER` chain and DNAT rewrites the destination to
the container. That converts local delivery into **forwarding** — which is
exactly what Tailscale masquerades. The source became the outbound interface's
address, the bridge gateway.

The host is not a subnet router (`AdvertiseRoutes: None`) and is not an exit
node, but DNAT-into-a-container is indistinguishable from routing into a subnet,
so the subnet-router masquerade applied anyway.

Measured with rule counters, same client and URL, varying only the path:

| Path | `ts-postrouting` | Docker DNAT `:443` | Traefik `ClientHost` |
|---|---|---|---|
| Tailnet | 172 → 173 | 70 → 71 | `172.18.0.1` |
| Public | 173 → 173 | 71 → 72 | the client's real public address |

Address family was not the variable — tailnet IPv4 and IPv6 both logged the
gateway. Public traffic arrives on `eth0`, never gets the mark, is DNAT'd only,
and its source survives.

**Fix:** `tailscale set --snat-subnet-routes=false`, which removes the
`ts-postrouting` masquerade. Traefik now logs true tailnet addresses.

Use `tailscale set`, **not** `tailscale up`. `up` re-applies the entire
preference set and silently resets flags not passed on the command line, on a
host whose only route in is the tailnet.

Verify against the live ruleset rather than the setting — `sudo nft list chain ip
nat ts-postrouting` should contain no `masquerade`. Reading `tailscale debug
prefs` reports intent, and intent diverging from effective state is the whole
reason this went unnoticed.

### Inbound IPv6 reached the same gateway address by a different route

This one is not obvious and is worth stating separately.

`hill90_edge` is IPv4-only, so Docker writes **no IPv6 DNAT rule** — the `ip6`
`nat DOCKER` chain is empty. But `docker-proxy` still binds the IPv6 wildcard,
`[::]:80` and `[::]:443`. An inbound IPv6 connection therefore has nothing to
redirect it, reaches the userspace proxy, and is re-originated to the container
from the bridge gateway. It then matched the same allowlist entry.

Removing `172.18.0.1/32` closed that path. The allowlist-only routes now answer
`403` to the public IPv6 literal and are unchanged over the tailnet:

```
                 tailnet     public IPv6 literal
grafana            302              403
portainer          200              403
vault              307              403
```

The zone still publishes no AAAA records, so nothing resolves there by name.
That is a second layer, not the control — the allowlist is what closes it. Decide
[#542](https://github.com/jonhill90/Hill90/issues/542) before adding AAAA records,
not after.

### Two traps when verifying this

**Absence proves nothing.** `accessLog` is filtered to `statusCodes: 400-599`, so
a *successful* request is never written. Grepping the log for `172.18.0.1` and
finding nothing is indistinguishable from the log being empty because everything
worked. Use a positive test: provoke a 4xx from a known client and assert the
expected address is present.

```bash
MARK=$(date +%s)
curl -sk --resolve "portainer.hill90.com:443:<tailscale-ip>" \
  "https://portainer.hill90.com/nope-$MARK"
# on the host:
docker logs traefik --since 3m | grep "nope-$MARK"
# pass: "ClientHost":"<the client's own tailnet address>"
```

**`traefik.hill90.com` is not a valid probe for the allowlist.** Its router is
`auth@file,tailscale-only@file`, and middlewares run in order, so basic auth
answers `401` before the allowlist is ever evaluated. A `401` there says nothing
about whether the request would have been admitted.

Probe `grafana`, `portainer` or `vault` instead — their routers carry
`tailscale-only@file` alone, so `403` means the allowlist rejected the request
and any other status means it admitted it.

## TLS And Certificate Controls

- Public services use Let's Encrypt HTTP-01.
- Tailscale-only services use Let's Encrypt DNS-01 via lego's built-in Cloudflare provider inside Traefik — they have no public A record, so HTTP-01 cannot validate them.
- ACME state is persisted in mounted Traefik storage for renewal continuity.
- Security headers are applied by a shared Traefik middleware.

## Operational Hardening

- Host firewall allows 80/443 publicly and blocks public SSH. Verified
  externally: port 22 on the public address refuses connections, and firewalld
  carries no `ssh` service. SSH is reachable over the tailnet only.
- **fail2ban is not installed.** This document previously said it was enabled.
  The bootstrap role attempted to install it with `ignore_errors: yes`, and
  fail2ban is in none of the repositories enabled on the host, so the install
  failed silently and the play reported success. The tasks were removed rather
  than left pretending. Restoring it would mean enabling EPEL — a deliberate
  decision about adding a third-party repository to a hardened host. Its value
  here is limited: SSH is not publicly reachable and accepts keys only, so there
  is no exposed surface for brute-force protection to defend.
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
- `sudo nft list chain ip nat ts-postrouting` contains no `masquerade` rule.
- A tailnet request to `portainer.hill90.com` logs the client's own tailnet
  address as `ClientHost`, not `172.18.0.1` — see the positive test above.
- `grafana`, `portainer` and `vault` answer `403` to the public IPv6 literal and
  their normal status over the tailnet.

## See Also

- [Architecture overview](./overview.md)
- [Secrets model](./secrets-model.md)
- [Certificate management](./certificates.md)
