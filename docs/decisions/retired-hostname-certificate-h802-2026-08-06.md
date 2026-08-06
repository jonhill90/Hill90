# `app-auth.hill90.com`'s certificate outlives its retirement — a documented decision, not a fix

`Verified 2026-08-06`. Filed against [h#802](https://github.com/jonhill90/Hill90/issues/802):
a retired hostname (`app-auth.hill90.com`, container and router removed 2026-07-30) still
holds a Let's Encrypt certificate, and `CertificateExpiringSoon` / `CertificateExpiringCritical`
have no exclusion for it.

## The question the issue asked, answered

The issue asked whether the alarm is wrong or the certificate is — they need opposite fixes,
and guessing wrong repairs the wrong thing. **The alarm is wrong. The certificate is not
broken and is not going to expire unattended.**

## Why: Traefik's renewal loop does not check whether a router still wants the domain

This repo pins Traefik v2.11 (`docs/architecture/certificates.md`). `renewCertificates` in
`pkg/provider/acme/provider.go` (tag `v2.11.24`, read directly, lines 781-834) iterates
`p.certificates` — the full ACME store loaded at startup — and renews anything inside the
renewal window. There is no check against the current router/dynamic configuration:

```go
for _, cert := range p.certificates {
    crt, err := getX509Certificate(ctx, &cert.Certificate)
    if err != nil || crt == nil || crt.NotAfter.Before(time.Now().Add(renewPeriod)) {
        certificates = append(certificates, cert)
    }
}
...
logger.Infof("Renewing certificate from LE : %+v", cert.Domain)
renewedCert, err := client.Certificate.RenewWithOptions(res, opts)
```

Removing a router does not remove the certificate from the store, and nothing about removing
a router tells Traefik to stop renewing it. This is a known, general Traefik behavior — the
ACME store is never garbage-collected — not something specific to this deployment.

## The renewal precondition is confirmed live, not assumed

A renewal only completes if the HTTP-01 challenge can still be served, so that was checked too:

- `dig +short app-auth.hill90.com A` → `76.13.26.69`, the same IP as `hill90.com`. DNS was
  never repointed when the router was retired.
- A harmless probe to `http://app-auth.hill90.com/.well-known/acme-challenge/test` was
  answered by Traefik's own internal, always-on challenge router:
  ```
  RouterName: "acme-http@internal"
  {"level":"error","msg":"Cannot retrieve the ACME challenge for app-auth.hill90.com (token \"test\")",...}
  ```
  That error is the expected response to a fake token — no real challenge was in progress and
  nothing was mutated. What it proves: the challenge path answers for this hostname
  unconditionally, independent of whether a router exists for it.

Both things a renewal needs are live. `app-auth.hill90.com` is currently tracking the exact
same ~60-day cadence as its issuance-batch siblings — `hill90.com`, `api.hill90.com` and
`ai.hill90.com` are all at 81.7-81.8 days remaining alongside it, decaying in lockstep, not
diverging. It will almost certainly keep auto-renewing indefinitely.

*(Honest limit: Traefik's container only started 2026-08-03, so no renewal cycle has actually
completed inside it yet — the nearest is `portainer`/`grafana` at ~37 days out. This is read
from the mechanism plus its confirmed live preconditions, not witnessed end to end, because
witnessing it means waiting two months.)*

## What this means for the two questions the issue posed

**The alarm does not need repair.** `CertificateExpiringSoon`/`Critical` firing for
`app-auth.hill90.com` specifically is unlikely — renewal happens well before the 21-day
threshold, same as every other certificate on the host. The threshold expressions are correct
as written and adding a CN exclusion would be solving a problem that doesn't exist while
opening the one the issue explicitly warned against: a hostname allowlist inside an alert
rule, going stale exactly like this document would if left unquestioned.

**The estate is not failing, but it is not clean either.** The retirement was incomplete: the
container and router are gone, the ACME entry is not, and it will silently keep renewing
forever — consuming one of the 5-certificates-per-domain-per-week Let's Encrypt budget every
~60 days, indefinitely, for a hostname that serves nothing.

## The corrected risk framing on removing it

The issue cited `acme-dns.json`'s multi-certificate bundling as the reason to be cautious
about dropping the stale certificate. Checked live: **`app-auth.hill90.com` is not in that
file.** Its router used `certresolver=letsencrypt` (HTTP-01, confirmed in
`docker-compose.auth.yml`'s git history), so it lives in the separate, smaller `acme.json`:

```
acme.json (resolver "letsencrypt", HTTP-01) — 5 entries:
  ai.hill90.com, api.hill90.com, app-auth.hill90.com, auth.hill90.com, hill90.com (+www SAN)

acme-dns.json (resolver "letsencrypt-dns", DNS-01) — 6 entries, the one worth being careful with:
  grafana, litellm, portainer, storage, traefik, vault
```
(Domain names only — no key material was read or printed. This count also corrected
`CLAUDE.md`'s own invariant 4, which said "four": see that PR's other change.)

`Certificates` is a plain JSON array per resolver. Removing the single element where
`.domain.main == "app-auth.hill90.com"` from `acme.json` touches neither `acme-dns.json` nor
the other 4 entries in `acme.json`. The blast radius is real but small — smaller than the
issue's framing suggested, because it conflated the two files' risk.

## Recommendation — not executed here, deliberately

Remove `app-auth.hill90.com`'s entry from `acme.json` (only that file, only that entry), then
restart Traefik so the in-memory store drops it. Nothing re-adds it afterward: the router that
would trigger reissuance was already removed 2026-07-30.

**This is a documented decision, not a fix, because the trade is bad to make unilaterally
regardless of how small the edit is.** The entire benefit is Let's Encrypt rate-limit headroom
for a hostname nobody uses. The cost is a live edit to a production certificate store plus a
Traefik restart, on the estate's only public TLS path — "the blast radius is smaller than
feared" is an argument that the edit is *safe*, not an argument that it is *worth doing
unilaterally*. Execution is left to Jon.

## What happens if nothing is done

Nothing, as far as anyone can tell from here: the certificate renews quietly forever, the
alarm does not fire, and the only ongoing cost is a slice of unused rate-limit budget. That is
a legitimate steady state to simply accept, distinct from "accept it and note the date" as
originally framed in the issue — there is no date after which this becomes true, because
nothing here is expected to change on its own.
