# Security Architecture

Hill90 uses layered controls to keep a small public surface reachable while
restricting administration to a private network.

## Access Boundaries

- Public internet access is limited to the HTTP/HTTPS entrypoints handled by
  Traefik. Only ports 80 and 443 are open on the host firewall.
- Every administrative surface — the Traefik dashboard, Portainer, Grafana, the
  OpenBao UI and the object-store console — is reachable only through Tailscale.
  Enumerated and verified 2026-07-31; see [Edge Audit](#edge-audit--verified-2026-07-31)
  for the evidence and for the surfaces that are deliberately public.
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
  - Applying it restarts `sshd` on a host reachable only over the tailnet, so the
    measured diff, the break-glass paths and the two-terminal verification are
    written up in [ssh-hardening-drop-in.md](../runbooks/ssh-hardening-drop-in.md).
    **Documented hardening not in force is not the same as an exposed host** —
    that page keeps both halves together.
- **OpenBao vault is the runtime source of truth for secrets.** SOPS + age serves as bootstrap and disaster-recovery backup. Deploy is vault-first with SOPS fallback, so a sealed or absent vault degrades to the encrypted file rather than failing.
- Each stack authenticates to vault via AppRole and reads only its assigned KV paths.
- Vault auto-unseals on boot via a systemd oneshot service; the unseal key is stored on the host at `/opt/hill90/secrets/openbao-unseal.key` with 0600 permissions.
- SOPS-encrypted secrets (`infra/secrets/prod.enc.env`) are decrypted only at deploy/runtime and not committed in plaintext.
- Vault-to-SOPS sync runs weekly via GitHub Actions to keep the SOPS backup current.
- See [Secrets Architecture](./secrets-model.md) for the full vault model.

## Admin Authentication

**Vault admin access is token-based. There is no single sign-on.**

**OIDC through Keycloak is ENABLED, and this paragraph said it had been removed.**
`Verified 2026-08-03` by a completed authorization-code login: `jon` authenticates
against realm `platform` through client `hill90-vault` and receives
`policy-oidc-admin`, bound on the realm role `platform-admin`. The claim is
`realm_roles`, deliberately not Keycloak's `realm_access.roles` default.
`scripts/checks/vault-oidc-login-test.sh` re-proves it.

For a root token: `vault.sh init` output, or the unseal key via
`bash scripts/vault.sh regain-root` (see `vault-regain-root.yml`). **Not**
`bao operator generate-root` — that CLI targets a legacy path and returns 403
whatever the configuration. Revoke generated root tokens immediately after use.

The Traefik dashboard and Portainer are protected by Traefik basic auth plus the
Tailscale IP allowlist. The dashboard password hash is generated at deploy time
from encrypted secrets into a gitignored `.htpasswd`.

## Email / SMTP

No service in the current stack sends email. Keycloak was the only sender;
`SMTP_PASSWORD` was removed with it.

## Network Segmentation

- `hill90_edge`: ingress-facing network for Traefik and the routed services.
- `hill90_internal`: `internal: true`, unreachable from outside the host; used for private service-to-service traffic.
- `hill90_agent_internal`: `internal: true`, created by the edge stack. Attached by the hill90-app tenant's `app-api` and `app-ai` containers.
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

**`traefik.hill90.com` used not to be a valid probe for the allowlist. It is now.**
Corrected 2026-07-31.

Its router was ordered `auth@file,tailscale-only@file`. Middlewares run left to
right, so basic auth answered `401` before the allowlist was evaluated, and a `401`
there said nothing about whether the request would have been admitted. That is what
the previous version of this paragraph described — and it described a defect as
though it were the design.

The defect was not only that the probe was useless. Off-network requests were being
handed a `WWW-Authenticate: Basic realm="traefik"` challenge — a credential prompt
and a guessing oracle — by a surface whose whole point is to be unreachable off the
tailnet. Every other administrative router refused outright.

The order is now `tailscale-only@file,auth@file`, so the allowlist decides first and
`traefik.hill90.com` behaves like the rest. A legitimate tailnet user is unaffected:
they pass the allowlist and meet basic auth exactly as before.

This is enforced rather than remembered. `scripts/checks/check_edge_middlewares.py`
fails CI if an IP allowlist is ever ordered behind an authenticator again, if a
router references a middleware that is not defined, or if a middleware's type key
does not match the pinned Traefik major version — the `ipWhiteList` → `ipAllowList`
rename in v3 being the case that would otherwise remove the allowlist silently.

Any of `traefik`, `grafana`, `portainer`, `vault` or `storage` is now a valid probe:
`403` means the allowlist rejected the request, and any other status means it
admitted it.

## Edge Audit — verified 2026-07-31

A full enumeration of what Traefik actually routes, and what protects each router,
established by behaviour rather than by reading labels. **Everything in this section is
a dated observation.** Router lists and container counts age; a dated claim that has
aged is honest, an undated one is simply wrong later.

### What protects the administrative surfaces, and how it was proven

The control is one middleware: `tailscale-only`, an IP allowlist whose source range is
the Tailscale CGNAT range and nothing else. It is referenced by every administrative
router. That it is *referenced* is not the same as it *working*, so it was tested from
three source classes against the same hostname on 2026-07-31:

| Source class | Result | `WWW-Authenticate` |
|---|---|---|
| the host's own tailnet address (inside the CGNAT range) | `401` — allowlist admitted it, basic auth challenged | present |
| IPv4 loopback | `403` — refused | none |
| IPv6 loopback | `403` — refused | none |

Corroborated from Traefik's own access log rather than inferred: the `401` was logged
with `ClientHost` equal to the tailnet address, and the refusals were logged with the
Docker bridge gateway as `ClientHost`. So the allowlist admits addresses inside the
CGNAT range and refuses everything else, including the two source classes most likely
to be assumed trusted.

**How the off-network case was established, and why it is sound.** No genuinely
external host was used. The refusing sources were loopback and the Docker bridge
gateway — both local to the VPS. That is sufficient here, and the reasoning is worth
keeping because it will be re-litigated:

- The middleware is a **source-IP set membership test**. It has exactly two branches:
  the address is inside the range, or it is not. Every address outside the range
  exercises the same branch, so loopback and the bridge gateway test the identical code
  path an arbitrary internet address would.
- Both directions were exercised. A one-sided test — only refusals — could not
  distinguish a working allowlist from a router that refuses everything. The `401` from
  a tailnet address is what makes the `403`s meaningful.
- The addresses were **observed in the log**, not assumed from where the command was
  typed. An earlier attempt at this measurement resolved the hostname to loopback
  without noticing, and would have recorded a loopback result as a tailnet one.

What this does **not** establish is anything about routing or reachability from a
specific external network — that was not tested and is not claimed.

### Routers loaded — 2026-07-31

Five administrative routers, all carrying the allowlist and all refusing off-network
requests as verified above: the Traefik dashboard, Portainer, Grafana, the OpenBao UI
and the object-store console. One further tenant router, the LiteLLM admin surface,
also carries it.

Three routers are public by design: the application UI at the apex, Keycloak, and the
application API. Their protection is authentication in the service, not network scoping.

The Traefik dashboard router was the only chain with two middlewares and so the only one
where ordering could be wrong; it was, and was fixed on this date.

### `exposedByDefault: false` — a correction worth keeping

Production Traefik sets **no provider constraints**, which is deliberate and is recorded
as an invariant. It is often described as meaning any container on the socket is "one
label away" from being public. **That is not accurate, and the difference matters.**

`exposedByDefault: false` is set, so a container needs *two* deliberate things — an
explicit `traefik.enable=true` **and** a router rule. Neither appears by accident.

Measured 2026-07-31: **11 running containers have neither.** The exposure surface is
therefore real but bounded, and it is bounded by an explicit opt-in rather than by luck.

### Open, not defects

**The API surface has no rate limiting, while the UI does.** The application UI carries
the shared rate-limit middleware; the application API carries no middleware at all. This
is not an exposure — the API is intended to be public and authenticates its callers —
but the asymmetry looks unintended rather than decided, since the API is the more
attackable of the two.

A proposal is open to attach the same shared rate-limit middleware to the API, on the
grounds that the identical limit is already proven in production on the UI and so is the
lowest-risk value available. It is **not** implemented, and it is not Hill90's change to
make: the platform owns the middleware definition, the tenant owns the reference, so it
belongs in the tenant's compose file. Awaiting a decision.

**The MCP path is internet-facing and protected in the service, not at the edge.** The
tenant's MCP gateway is routed publicly under a path prefix with only a path-strip
middleware — no allowlist, no edge authentication. Probed 2026-07-31: its health
endpoint answers unauthenticated, which is intended for a health probe, and no other
path under that prefix was reachable anonymously.

The caveat is the point: **the protection lives in the service.** No edge middleware
would stop a future route added under that prefix from being public the moment it ships.
Anything mounted there is public unless the service itself refuses it.

## TLS And Certificate Controls

- Public services use Let's Encrypt HTTP-01.
- Tailscale-only services use Let's Encrypt DNS-01 via lego's built-in Cloudflare provider inside Traefik, because HTTP-01 cannot validate them.
  - **Correction, 2026-07-31: the reason is that they are unreachable, not that they are unpublished.** This line previously said they "have no public A record". They do. Each of the Tailscale-only hostnames resolves on public resolvers to the host's private tailnet address, so that anyone on the tailnet can resolve them without extra client configuration. The addresses returned are unroutable from the internet, which is why HTTP-01 still cannot reach them — but the names and their answers are public. The same error was carried in the published documentation and corrected there on the same date. Anyone reasoning about exposure should start from *unreachable*, not *unpublished*.
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
