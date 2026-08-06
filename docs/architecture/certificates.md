# Certificate Management Architecture

## Overview

Hill90 uses Let's Encrypt for SSL/TLS certificates with two different challenge methods:

1. **HTTP-01** - For public services (api, MCP gateway on ai.hill90.com)
2. **DNS-01** - For Tailscale-only services (traefik, portainer, storage)

## Why DNS-01 for Tailscale Services?

**Problem:** Traefik and Portainer are accessible ONLY via Tailscale network (100.64.0.0/10), not from the public internet.

**HTTP-01 limitations:**
- Let's Encrypt validation servers must connect to port 80/443
- Requires service to be publicly accessible
- Cannot validate Tailscale-only services

**DNS-01 solution:**
- Let's Encrypt validates via DNS TXT records
- No public HTTP access required
- Works for any domain, even private/internal services

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Let's Encrypt (Validation Server)                          │
└─────────────────────────────────────────────────────────────┘
                    │                        │
                    │ HTTP-01               │ DNS-01
                    │ (port 80)             │ (DNS query)
                    ▼                        ▼
        ┌───────────────────┐    ┌───────────────────┐
        │ Public Services   │    │ DNS Records       │
        │ - api.hill90.com  │    │ _acme-challenge.  │
        │ - ai.hill90.com   │    │   traefik.hill90  │
        └───────────────────┘    └───────────────────┘
                    │                        │
                    │                        │
                    ▼                        ▼
        ┌───────────────────┐    ┌───────────────────┐
        │ Traefik (HTTP-01) │    │ Traefik + lego    │
        │ Challenges        │    │ cloudflare provider│
        └───────────────────┘    └───────────────────┘
                                           │
                                           ▼
                                 ┌───────────────────┐
                                 │ Cloudflare DNS API│
                                 └───────────────────┘
```

## DNS-01 Challenge Implementation

### lego's built-in Cloudflare provider

**Location:** none — this is configuration, not code.

Traefik embeds [lego](https://go-acme.github.io/lego/), which ships a
first-class Cloudflare provider. Setting `provider: cloudflare` and supplying
`CF_DNS_API_TOKEN` is the entire integration. There is no webhook service to
run, no TXT value to compute, and no zone-specific record-name arithmetic to get
wrong.

This replaced a local `dns-manager` service that translated lego's `httpreq`
provider calls into Hostinger DNS API writes. It was removed when the zone moved
to Cloudflare; see the "History" section below.

**Challenge Flow:**

1. **Traefik requests a certificate** for a Tailscale-only host and hands the
   DNS-01 challenge to lego.

2. **lego creates the TXT record** directly against the Cloudflare API,
   computing `base64url(SHA256(keyAuth))` itself:
   ```
   POST https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records
   { "type": "TXT", "name": "_acme-challenge.traefik.hill90.com", ... }
   ```

3. **Traefik waits for DNS propagation:**
   ```yaml
   # platform/edge/traefik.yml.tmpl  (rendered to traefik.generated.yml at deploy)
   dnsChallenge:
     delayBeforeCheck: 30s  # Wait for DNS to propagate
   ```

4. **Let's Encrypt validates:**
   ```
   dig TXT _acme-challenge.traefik.hill90.com
   → Matches expected value → Certificate issued
   ```

5. **lego deletes the TXT record.** Cleanup is part of the provider, so the zone
   does not accumulate stale challenge records.

### Traefik Configuration

**Certificate Resolvers:**

```yaml
# platform/edge/traefik.yml.tmpl  (rendered to traefik.generated.yml at deploy)

certificatesResolvers:
  # HTTP-01 for public services (api, ai, mcp)
  letsencrypt:
    acme:
      email: admin@hill90.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web

  # DNS-01 for Tailscale-only services (traefik, portainer, storage)
  letsencrypt-dns:
    acme:
      email: admin@hill90.com
      storage: /letsencrypt/acme-dns.json
      dnsChallenge:
        provider: cloudflare
        delayBeforeCheck: 30s
        resolvers:
          - 1.1.1.1:53
          - 8.8.8.8:53
```

> **Traefik is pinned to v2.11.** On v2.11 the `dnsChallenge` keys are flat:
> `provider`, `delayBeforeCheck`, `resolvers`, `disablePropagationCheck`. The
> `propagation.*` block (`propagation.delayBeforeChecks`, and friends) is
> **Traefik v3 only** — writing it here would parse without error and silently
> do nothing. Check the pinned version before copying from current Traefik docs.

> **Important:** Traefik does NOT interpolate `${VAR}` in its own YAML config.
> Email is hardcoded in the template.

### How `ACME_CA_SERVER` reaches Traefik

Traefik has three static-configuration sources — a file, CLI flags, and
environment variables — and the v2.11 docs state they are **"mutually exclusive
(i.e. you can use only one at the same time)"**. Because a config file is
mounted, the CLI flags and environment variables are discarded.

This repository used to pass the CA as
`--certificatesresolvers.*.acme.caserver=${ACME_CA_SERVER}` in the compose
`command:`. Compose interpolated it faithfully; Traefik then threw it away. So
`ACME_CA_SERVER` and the Ansible `letsencrypt_env` variable were **inert**, both
resolvers silently used the Traefik default (production Let's Encrypt), and
nobody could test issuance against staging.

The CA is now rendered into the config file itself:

```
platform/edge/traefik.yml.tmpl          <- authoritative, edit this
        |  scripts/render-traefik-config.sh   (deploy time, both vault and SOPS paths)
        v
platform/edge/traefik.generated.yml     <- gitignored, mounted by compose
```

### `ACME_CA_SERVER` is required and has no default

`render-traefik-config.sh` refuses to render without it, and both deploy paths
abort. That required care: the SOPS fallback runs its deploy inside
`sops exec-env '<command>'`, a new shell that does not inherit `deploy.sh`'s
`set -e`, and `exec-env` returns 0 regardless of what the command did. Without
an explicit `set -e` inside that string, a failed render was swallowed and
`docker compose up` ran anyway.
Both possible defaults are dangerous, in opposite directions:

| Default | Failure |
|---|---|
| **Staging** (what the compose file used to do) | Any deploy without secrets loaded silently replaces every certificate with an untrusted one. Browsers hard-fail. |
| **Production** | An unconfigured environment burns real rate limits — 50 certificates per registered domain per week, 5 failed validations per hostname per hour. |

A deploy that stops is strictly better than either. Selecting staging still
renders, but warns loudly — an intentional staging deploy is fine, an accidental
one must not pass unremarked.

### ⚠️ Recovering from an accidental staging issuance is expensive

This is why the staging default mattered so much more than it looks.

**Traefik will not reissue a certificate it considers valid.** A staging
certificate is structurally valid — correctly signed, unexpired — it is merely
signed by a CA no browser trusts. So redeploying with the right CA does *not* fix
it. Traefik looks at its store, sees a valid certificate, and keeps serving it.

Recovery means deleting the stored certificates so Traefik requests new ones:

- The ACME stores live in the `traefik-certs` Docker volume, **root-owned**
  inside the container.
- `acme-dns.json` holds **six DNS-01 certificates in one file**, `Verified
  2026-08-06` — grafana, litellm, portainer, storage, traefik, vault. There is
  no way to clear one host's certificate without clearing the others; every one
  of them is reissued. *(Said "all four ... traefik, portainer, grafana, vault"
  until `litellm` and `storage` joined the DNS-01 resolver; found while
  investigating h#802.)*
- `acme.json` separately holds the HTTP-01 certificate for `auth`.
- The stored ACME **account registrations** are production registrations, which
  is a further mismatch when the resolver has been pointed at staging.

So a single unconfigured deploy costs a full reissue of every certificate on the
host, performed by hand against root-owned files. That is the cost being avoided
by refusing to guess a default.

**Environment Variables:**

```yaml
# deploy/compose/prod/docker-compose.infra.yml

environment:
  - CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN:-}
```

The token must be scoped to the `hill90.com` zone with exactly two permissions —
**Zone / Zone / Read** and **Zone / DNS / Edit**. Do not use a Global API Key: it
carries full account access and cannot be scoped.

Optional lego tuning variables, none of which are set here because the defaults
are correct for this zone (verified against the
[lego Cloudflare docs](https://go-acme.github.io/lego/dns/cloudflare/)):

| Variable | Default |
|---|---|
| `CLOUDFLARE_POLLING_INTERVAL` | 2s |
| `CLOUDFLARE_PROPAGATION_TIMEOUT` | 120s |
| `CLOUDFLARE_TTL` | 120s |

The old `HTTPREQ_*` tuning does not carry over by name — those variables were
consumed by the `httpreq` provider and are simply gone.

**Router Labels:**

```yaml
# Tailscale-only service using DNS-01
labels:
  - "traefik.http.routers.traefik.tls.certresolver=letsencrypt-dns"
  - "traefik.http.routers.traefik.middlewares=auth@file,tailscale-only@file"
```

## Critical DNS-01 Implementation Details

### 1. What lego handles for you now

The TXT value, the FQDN, and the record cleanup are all lego's responsibility
now. The failure modes that used to dominate this section — computing the TXT
value from `token` instead of `base64url(SHA256(keyAuth))`, blocking inside
`/present` until Traefik timed out, disagreeing about `fqdn` vs `domain` — were
all defects in the shim and cannot occur with a built-in provider.

What remains yours to get right is the **token**.

### 2. Token scope

The token needs exactly **Zone / Zone / Read** and **Zone / DNS / Edit**, on the
`hill90.com` zone only. Under-scoping fails at `present` time with a 403 from the
Cloudflare API; over-scoping (a Global API Key) works but hands full account
access to the edge proxy.

### 3. Timing Considerations

Traefik waits 30s (`delayBeforeCheck: 30s`) before asking Let's Encrypt to
validate, and checks propagation against `1.1.1.1` and `8.8.8.8`. lego's own
Cloudflare defaults — 2s polling, 120s propagation timeout — apply underneath.

## Troubleshooting

### Certificate Acquisition Failures

Traefik logs the challenge result directly; there is no separate service to
check. **Do not infer success from the container being healthy** — Traefik stays
healthy through a failed renewal.

```bash
ssh deploy@<tailscale-ip> 'docker logs traefik --tail 100 | grep -i "acme\|certificate\|challenge"'
```

**Common issues:**

1. **Bad or under-scoped token:**
   ```
   Error: cloudflare: failed to find zone hill90.com: ... HTTP status 403
   ```
   **Fix:** Confirm the token has Zone/Zone/Read *and* Zone/DNS/Edit and that
   `CF_DNS_API_TOKEN` actually reached the container
   (`docker exec traefik env | grep CF_DNS`).

2. **Zone not served by Cloudflare yet:**
   ```
   Error: cloudflare: ... zone could not be found
   ```
   **Fix:** The nameservers must point at Cloudflare. A zone in `pending` status
   is not yet authoritative.

3. **Rate limiting:**
   ```
   Error: 429 :: too many failed authorizations (5) for "traefik.hill90.com"
   ```
   **Fix:** Wait 1 hour, use STAGING certificates for testing.

### DNS Record Verification

**Check if TXT record was created:**
```bash
dig TXT _acme-challenge.traefik.hill90.com @8.8.8.8
```

Watch **both halves** of the lifecycle: the record must appear during issuance
and then disappear afterwards. A provider that creates but never cleans up
leaves the zone accumulating junk, and that is invisible if you only check once.

**Check the record in the Cloudflare zone** (dashboard → hill90.com → DNS, or
the API with the same scoped token).

### Certificate Verification

**Check certificate issuer:**
```bash
echo | openssl s_client -connect traefik.hill90.com:443 -servername traefik.hill90.com 2>/dev/null | \
  openssl x509 -noout -issuer
```

**Expected:**
```
issuer=C=US, O=Let's Encrypt, CN=R12  # Production
issuer=C=US, O=(STAGING) Let's Encrypt, CN=(STAGING) Ersatz Edamame E1  # Staging
```

## Rate Limits

**Let's Encrypt Production:**
- 50 certificates per registered domain per week
- 5 validation failures per account per hostname per hour

**Let's Encrypt Staging:**
- Much higher limits (for testing)
- Not trusted by browsers (expect certificate warnings)

**Best practices:**
1. Use staging certificates during development
2. Only switch to production when ready
3. Test DNS-01 implementation thoroughly before production
4. Monitor certificate expiry (auto-renewal at 60 days)

## Security Considerations

1. **Cloudflare API token:** Stored in SOPS-encrypted secrets and in OpenBao at
   `secret/infra/traefik`. Scoped to the `hill90.com` zone, never a Global API Key.
2. **DNS records:** Zone/DNS/Edit permits more than TXT writes, so the blast
   radius of the token is the zone, not just challenge records. This is the cost
   of using the built-in provider; Cloudflare does not offer a TXT-only scope.
3. **Challenge cleanup:** lego removes TXT records after validation.
4. **Middleware protection:** Tailscale-only services use IP whitelist middleware

## History

DNS-01 originally ran through `services/dns-manager`, a small Flask service that
translated lego's `httpreq` provider calls into Hostinger DNS API writes. When
`hill90.com` moved to Cloudflare, the shim was deleted rather than ported: lego
has a first-class Cloudflare provider, so the whole thing collapsed into
configuration.

Hostinger remains the VPS host and the mail provider. `scripts/hostinger.sh`,
`scripts/vps.sh` and `HOSTINGER_API_KEY` are unrelated to certificates and stay.

## References

- **ACME DNS-01 Spec:** [RFC 8555 Section 8.4](https://datatracker.ietf.org/doc/html/rfc8555#section-8.4)
- **lego Cloudflare Provider:** [go-acme.github.io/lego/dns/cloudflare](https://go-acme.github.io/lego/dns/cloudflare/)
- **Traefik v2.11 ACME Docs:** [doc.traefik.io/traefik/v2.11/https/acme](https://doc.traefik.io/traefik/v2.11/https/acme/)
