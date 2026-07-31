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
querying it.

The rules, their thresholds and the reasoning behind the numbers are specified
below under [Proposed: the alert that would notice](#proposed-the-alert-that-would-notice).

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

## The alert that notices — APPLIED

> **`Applied 2026-07-31 09:57 UTC`.** These rules are live in
> `platform/observability/prometheus/alerts.yml`, delivered by the Alertmanager
> that #617 shipped. The thresholds below are unchanged from the specification —
> they were argued here and were not re-picked.
>
> **Both were proven to fire**, not merely validated: a stub exposing
> `traefik_tls_certs_not_after` with the real label set
> (`cn, instance, job, sans, serial`) at 15 and 5 days produced
> `CertificateExpiringSoon` on both and `CertificateExpiringCritical` on the
> 5-day one only, and the emails arrived. A third series at 80 days correctly
> matched neither.
>
> Series verified on the live Prometheus first, per #619: 11 series, `cn` present
> on all of them, and `(value - time())/86400` yielding 42.7–87.8 real days rather
> than an empty vector.
>
> **`CertificateCountDropped` is the exception and is honestly weaker.** Its
> `offset 1h` comparison cannot be exercised in a short-lived test instance, which
> has no hour of history. What was verified instead is that both halves evaluate
> on the live Prometheus — `count(...)` and `count(... offset 1h)` both return 11 —
> so the rule compares two real numbers rather than silently returning nothing.
> It has not been observed firing.

`Specified 2026-07-31.`

### The metric needs nothing turned on

The first question is whether Traefik's certificate metric requires an option to
be enabled, and therefore a restart of the edge. **It does not.** Verified at the
source, not inferred from the config:

```
$ docker exec traefik wget -qO- http://localhost:8082/metrics | grep -c '^traefik_tls_certs_not_after'
11

traefik_tls_certs_not_after{cn="ai.hill90.com",sans="ai.hill90.com",serial="…"} 1.793076175e+09
```

Eleven series — one per certificate — already exposed and already scraped by the
existing `traefik` job. **No configuration change, no restart, nothing for anyone
to sequence.** The edge is the one component whose failure takes everything with
it, so the fact that this needs no change to it is the main reason to prefer it.

### Metric, not endpoint — and what that costs

| | Metric (`traefik_tls_certs_not_after`) | Probing the served certificate |
|---|---|---|
| Cost today | **zero** — collected already | a new component (`blackbox_exporter`); no prober exists |
| Covers tailnet-only hosts | yes, all 11 | only from inside the tailnet |
| Tests what a user receives | **no** — what Traefik believes it holds | **yes** |
| Restart of the edge | none | none, but a new container to deploy |

**Choose the metric.** It is free, immediate, covers every certificate including
the six that are unreachable from outside the tailnet, and touches nothing on the
edge.

**Be honest about the gap it leaves.** The metric reports what Traefik *holds*.
If Traefik ever served the wrong certificate — the built-in self-signed default,
because an ACME entry was lost — the expiry metric would not show a bad value. It
would show **nothing at all**, because the series would disappear. Confirmed by
counting: 11 ACME certificates in the stores, 11 series, and no series for the
default certificate.

That is a different failure from the one being alerted on, and it is why a
served-certificate probe is worth adding **later** — not as the first thing,
because it costs a new component to catch a rarer fault. The companion rule below
covers the cheap half of it.

### The threshold, argued against the actual window

Let's Encrypt issues for **90 days**. Traefik renews below **30 days** remaining
and retries every **24 hours**. So in a healthy estate a certificate never drops
far below 30 days — and every day below 30 is **one more failed attempt**.

That turns the threshold into a straightforward question: how many consecutive
failures before it is worth waking someone, and how much runway do they need?

| Threshold | Failures before firing | Runway left | Verdict |
|---|---|---|---|
| 29 days | 1 | 29 days | **No.** Fires on any single slow renewal — a Let's Encrypt hiccup, one Cloudflare API timeout. Alerts that cry wolf get filtered, and then the real one is filtered too |
| **21 days** | **9** | **21 days** | **Warning.** Nine consecutive daily failures is not a blip. Three weeks is comfortably enough to mint a token, update SOPS and deploy |
| **10 days** | **20** | **10 days** | **Critical.** Twenty days of failure means the first alert was missed. Still fixable, no longer comfortable |
| 7 days | 23 | 7 days | **No.** Fixing a revoked DNS token means Cloudflare dashboard, a SOPS edit and an edge deploy. Seven days that begin on a Friday of a long weekend is thin |

```yaml
# platform/observability/prometheus/alerts.yml — NOT yet applied
- alert: CertificateExpiringSoon
  expr: (traefik_tls_certs_not_after - time()) / 86400 < 21
  for: 1h
  labels:
    severity: warning
  annotations:
    summary: "{{ $labels.cn }} expires in {{ $value | printf \"%.0f\" }} days"
    description: >-
      Renewal has been failing for roughly nine days. Traefik renews below 30
      days and retries every 24h, so every day under 30 is another failed
      attempt. Runbook: docs/runbooks/certificate-renewal.md

- alert: CertificateExpiringCritical
  expr: (traefik_tls_certs_not_after - time()) / 86400 < 10
  for: 1h
  labels:
    severity: critical
  annotations:
    summary: "{{ $labels.cn }} expires in {{ $value | printf \"%.0f\" }} days"
```

`for: 1h` is not about the certificate — the value moves once a day. It guards
against a single failed scrape producing a spurious evaluation.

### Companion: a certificate that vanished rather than aged

Cheap, and covers the failure the expiry rule structurally cannot see.

```yaml
- alert: CertificateCountDropped
  expr: |
    count(traefik_tls_certs_not_after)
      < count(traefik_tls_certs_not_after offset 1h)
  for: 2h
  labels:
    severity: warning
```

Self-adjusting, so adding or retiring a host does not need the rule edited. The
`for: 2h` matters: a Traefik restart makes every series vanish briefly, and
`ServiceDown` already covers Traefik being down — this must not double-report it.

**Delivery is the open half.** A rule with no receiver changes nothing; that is
the subject of the alerting audit, and the certificate rule should land with
whichever delivery path is chosen there rather than ahead of it.

## When the alert fires: what to do at 3am

The alert names one certificate and a number of days. Work in this order — it is
arranged so the cheapest discriminator comes first.

**1. How much time is actually left, and is it one certificate or several?**

```bash
docker exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=(traefik_tls_certs_not_after-time())/86400'
```

**This is the important branch.** If **several DNS-01 hosts** — `traefik`,
`portainer`, `grafana`, `vault`, `litellm`, `storage` — are all falling together,
go straight to step 3: they share one credential and one store, and a single
certificate failing alone is a different problem from all six failing at once.

**2. What does Traefik say it tried?**

```bash
docker logs traefik --since 48h 2>&1 | grep -iE 'acme|certificate|challenge' | tail -40
```

Grep for `challenge` as well as `certificate`: a revoked Cloudflare token fails
as a **DNS challenge error**, not as a certificate error, so grepping only for
the latter finds nothing and looks like silence.

**3. Is the Cloudflare credential still there and still valid?**

```bash
# Presence only. Never echo the value.
docker inspect traefik --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -c '^CF_DNS_API_TOKEN='
```

Present but rejected looks like a `403`/`9109` from the Cloudflare API in the
logs above. Absent means the deploy that should have injected it did not.

**4. Fix the cause, then let the normal cycle run.**

If the token is the problem: mint a replacement in Cloudflare scoped to the
`hill90.com` zone with **Zone:Read + DNS:Edit**, store it in SOPS, and redeploy
the edge. Traefik retries on its own within 24 hours — with 21 days of runway
there is no need to force anything.

**Restarting Traefik forces an immediate attempt, and is a deliberate act**, not
a debugging reflex: it drops in-flight connections on the one component every
service is behind. If you have days of runway, wait for the cycle.

### What not to do

- **Do not delete `acme-dns.json`** to "start clean". It holds the ACME account
  key and all six DNS-01 certificates; deleting it forces re-registration and
  re-issuance straight into Let's Encrypt's rate limits — including **5 duplicate
  certificates per week** — at the moment you can least afford to be blocked.
- **Do not edit the ACME configuration under time pressure.** A mistake there
  means reissuing for a live site, against those same limits.
- **Do not switch `caServer` to staging to "test".** Staging certificates are
  untrusted by browsers, and the repo guards against that mix-up because it is
  easy to leave behind.

### Diagnostics that are safe to run

```bash
# Which resolver owns the failing host, and what Traefik currently holds:
docker exec traefik wget -qO- http://localhost:8082/metrics | grep '^traefik_tls_certs_not_after'

# Is the DNS-01 provider reachable at all (challenge records live in Cloudflare):
dig +short _acme-challenge.<host>.hill90.com TXT
```

## Scope of this proposal

**Nothing was enabled, deployed or restarted.** The metric was read from the
running Traefik and Prometheus read-only; the alert rules above are written out
to be pasted into `platform/observability/prometheus/alerts.yml`, not added to
it, because adding them applies them on the next deploy.

The delivery half — where a firing alert actually goes — is the subject of
[../decisions/alerting-audit.md](../decisions/alerting-audit.md), which ranks the
certificate alert as the first thing worth having. These rules should land
**with** whichever receiver is chosen there. A rule with no receiver is the same
silence in a different file.
