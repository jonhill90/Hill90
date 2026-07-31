# Certificate renewal: what we hold, and how much warning a failure gives

**Nothing is wrong today, and the nearest expiry is comfortably far out.** This
page exists because ACME failures are silent — nothing breaks on the day, and the
site disappears thirty days later — so the useful thing to write down is the
runway and the warning window, not an alarm.

`Measured 2026-07-31. No configuration was changed.`

---

## The planning fact

**Nearest expiry: 2026-09-12 — 42 days out.** Everything else is 84–87 days.

| Certificate | Resolver | Issued | Expires | Days |
|---|---|---|---|---|
| `portainer.hill90.com` | DNS-01 | Jun 14 | **Sep 12** | **42** |
| `grafana.hill90.com` | DNS-01 | Jun 14 | **Sep 12** | **42** |
| `vault.hill90.com` | DNS-01 | Jul 26 | Oct 24 | 84 |
| `auth.hill90.com` | HTTP-01 | Jul 26 | Oct 24 | 85 |
| `traefik.hill90.com` | DNS-01 | Jul 27 | Oct 25 | 85 |
| `hill90.com` (+`www`) | HTTP-01 | Jul 29 | Oct 27 | 87 |
| `app-auth.hill90.com` | HTTP-01 | Jul 29 | Oct 27 | 87 |
| `api.hill90.com` | HTTP-01 | Jul 29 | Oct 27 | 87 |
| `ai.hill90.com` | HTTP-01 | Jul 29 | Oct 27 | 87 |
| `litellm.hill90.com` | DNS-01 | Jul 29 | Oct 27 | 87 |
| `storage.hill90.com` | DNS-01 | Jul 29 | Oct 27 | 87 |

**Eleven certificates, not the four this was previously thought to be.** The
DNS-01 store now holds **six** — `litellm` and `storage` were added on Jul 29.

**The next event is 2026-08-13**, when Traefik will first attempt to renew the
two Jun 14 certificates. That is the first renewal to run entirely through
Cloudflare, and it is the one worth watching.

## Production CA, confirmed three ways

The repo guards against a staging/production mix-up deliberately. It has not
happened here:

1. `caServer: https://acme-v02.api.letsencrypt.org/directory` in the rendered
   `traefik.generated.yml` — for **both** resolvers.
2. The ACME **account** URI inside each store points at
   `https://acme-v02.api.letsencrypt.org`.
3. Every certificate's issuer is `C=US, O=Let's Encrypt, CN=YR1` or `YR2` — real
   intermediates. A staging certificate would say `(STAGING)` and be issued by
   `Pretend Pear` / `Fake LE`.

## The two resolvers, and the shared-fate question

| | `letsencrypt` | `letsencrypt-dns` |
|---|---|---|
| Challenge | HTTP-01 via the `web` entrypoint | DNS-01 via **Cloudflare** |
| Store | `/letsencrypt/acme.json` | `/letsencrypt/acme-dns.json` |
| Certificates | 5 (public hosts) | 6 (tailnet-only hosts) |

Both stores are `0600 root:root` inside the `prod_traefik-certs` volume.

**Shared fate is real, and there are two separate mechanisms for it** — worth
separating, because they have different fixes:

- **One credential.** All six DNS-01 certificates renew using the same
  `CF_DNS_API_TOKEN`. Revoke or expire that token and *all six* stop renewing
  together, while the five HTTP-01 certificates carry on unaffected.
- **One file.** `acme-dns.json` holds the account key *and* all six
  certificates. Lose or corrupt it and Traefik re-registers and re-issues from
  scratch — which is recoverable, but runs into Let's Encrypt rate limits
  (notably 5 duplicate certificates per week) exactly when you are in a hurry.

`CF_DNS_API_TOKEN` **is present** in Traefik's environment today. It is scoped to
the `hill90.com` zone with Zone:Read + DNS:Edit. If it were revoked, DNS-01
challenges would fail with a Cloudflare API error, Traefik would log at `ERROR`,
and it would keep retrying — see the window below. Nothing would break until the
certificates actually expired.

## How much warning a failure gives

Traefik **2.11.53**, no `certificatesDuration` override, so the defaults apply:

- It checks certificates **every 24 hours**.
- It renews when a certificate has **less than 30 days** remaining.
- A failed attempt is retried on the next cycle. It does not give up.

**So the window is 30 days, and roughly 30 attempts.** From the first failed
renewal to the certificate actually expiring, there is a month of daily failures
being logged.

That is a generous window — *if anyone is looking*.

## Would anyone see it? Today, no

This is the finding, and it is the gap rather than the certificates.

**What works:** ACME failures log at `ERROR` to Traefik's stdout, promtail ships
them to Loki, and they are queryable in Grafana. The signal exists.

**What does not:**

- **No certificate alert.** `alerts.yml` defines six rules — `ServiceDown`,
  `HighMemoryUsage`, `DiskSpaceRunningLow`, `PostgresConnectionsHigh`,
  `LokiIngestionErrors`, `TempoIngestionErrors`. **None mentions certificates,
  TLS or expiry.**
- **No Alertmanager.** `prometheus.yml` has `rule_files:` but **no `alerting:`
  section**, and no Alertmanager container runs. The six existing rules evaluate
  and are visible on Prometheus's own Alerts page — and notify nobody.
- **No Grafana alerting.** Its provisioning directory holds `dashboards` and
  `datasources` only.

So a renewal failure would produce thirty days of ERROR lines that no one is
paged about. The warning window is real and currently unwatched.

**The cheap fix is unusually cheap, because the data is already there.**
Prometheus already scrapes Traefik (`job_name: traefik`) and already holds
`traefik_tls_certs_not_after` — **11 series, one per certificate**, verified by
querying it. An expiry alert is a handful of lines in `alerts.yml` against a
metric that is already collected:

```yaml
- alert: CertificateExpiringSoon
  expr: (traefik_tls_certs_not_after - time()) / 86400 < 21
  for: 1h
```

Twenty-one days sits deliberately *inside* the 30-day renewal window: it fires
only once renewal has been failing for about nine days, so a single transient
failure does not page anyone, while a stuck renewal does.

**An alert rule without a notification path only moves the problem**, so the
Alertmanager gap should be settled in the same change or the rule will be as
unwatched as the logs. That is a decision about notification channels, not a
lane's to take.

## Current health, from evidence

- **Zero `level=error` and zero `level=warn` lines from Traefik in the last 7
  days** (Loki's full retention window), and zero ACME errors.
- **Seven certificate obtain/renew lines** in the same period, consistent with
  the Jul 26–29 issuances.
- Traefik logs `Testing certificate renew...` against
  `https://acme-v02.api.letsencrypt.org/directory` on every start.
- **The Cloudflare DNS-01 path is proven, not assumed.** `storage.hill90.com`
  and `litellm.hill90.com` were both issued through it on Jul 29, after the
  `dns-manager` retirement. Issuance and renewal use the same code path, so this
  is good evidence the August renewal will work — not proof, which only Aug 13
  provides.

## If a renewal does fail

```bash
# What Traefik thinks, in its own words:
docker logs traefik --since 48h 2>&1 | grep -iE 'acme|certificate|challenge' | tail -30

# Days remaining, per certificate, from the metric that already exists:
docker exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=(traefik_tls_certs_not_after-time())/86400'

# Is the Cloudflare credential still there at all? (name only — never echo it)
docker inspect traefik --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -c '^CF_DNS_API_TOKEN='
```

A DNS-01 failure after a token revocation shows as a Cloudflare API error on the
challenge, not as a certificate error — so grep for `challenge` as well as
`certificate`.

**Do not edit the ACME configuration to "fix" a renewal.** A mistake there means
reissuing certificates for a live site, against rate limits, under time pressure.
Diagnose first; the 30-day window is there to be used.
