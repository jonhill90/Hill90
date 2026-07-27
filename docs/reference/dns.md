# DNS Management for Hill90

`hill90.com` is served by **Cloudflare**. DNS operations go through
`scripts/cloudflare.sh`, which talks to the Cloudflare API one record at a time.

Hostinger is still the **VPS host** and the **mail provider**. `scripts/hostinger.sh`
covers VPS lifecycle only and no longer has any DNS commands. The MX, SPF, DKIM
and DMARC records continue to point at Hostinger mail and are not managed by
anything in this repository.

Every record in the zone is **dns-only** (grey cloud). Nothing is proxied:
Cloudflare cannot proxy SMTP, and the Tailscale-only hosts resolve into
`100.64.0.0/10`, which a proxy cannot reach.

> **No IP addresses appear in this document on purpose.** They change on VPS
> rebuild and are stored in SOPS. Use `make secrets-view KEY=VPS_IP` and
> `make secrets-view KEY=TAILSCALE_IP` for current values.
>
> This is not stylistic. **Every file in this repository that has hardcoded an
> address or a record set has turned out to be wrong**, and each was wrong
> silently, in a way only discovered by going and asking the live system:
>
> | Artifact | What it claimed | Reality |
> |---|---|---|
> | `hill90-dns-backup.json` | a stale `remote` address | superseded IP |
> | `infra/dns/hill90.com.json` | read as "the zone" | a 7-record subset of 32 — **deleted**, see below |
> | this document, before 2026-07-26 | `remote` = a Mac at `31.97.42.69`; Tailscale IP `100.78.82.89` | `remote` is the **VPS**, on the current Tailscale IP |
>
> The last one is instructive: `dns_sync` and the bats suite had described
> `remote` correctly as the VPS SSH path the whole time. The prose disagreed with
> the code, and the prose was wrong.
>
> The rule that follows: **the live system and the code are the sources of truth
> for addresses; documentation names variables, never values.**

## Credential

DNS operations use `CF_DNS_API_TOKEN` — the **same token Traefik uses for ACME
DNS-01**, deliberately not a second credential. It lives in
`infra/secrets/prod.enc.env` and in OpenBao at `secret/infra/traefik`.

Scope: the `hill90.com` zone only, with `Zone / Zone / Read` and
`Zone / DNS / Edit`. Never a Global API Key — that carries full account access
and cannot be scoped.

`cloudflare.sh` reads the token from `CF_DNS_API_TOKEN` if set, otherwise from
the SOPS-encrypted secrets file.

## What is managed, and what is not

`scripts/cloudflare.sh` maintains exactly seven A records — the ones whose value
changes when the VPS is rebuilt:

| Record | Points at |
|---|---|
| `hill90.com` (apex) | `VPS_IP` — the public address |
| `remote.hill90.com` | `TAILSCALE_IP` |
| `vps.hill90.com` | `TAILSCALE_IP` |
| `portainer.hill90.com` | `TAILSCALE_IP` |
| `traefik.hill90.com` | `TAILSCALE_IP` |
| `grafana.hill90.com` | `TAILSCALE_IP` |
| `vault.hill90.com` | `TAILSCALE_IP` |

`remote.hill90.com` matters more than the rest: public SSH is locked down, so
that record on the Tailscale IP is the only way back into the box.

The zone holds roughly 33 record groups. **Everything else — mail, `www`, `docs`,
the CAA records, the minecraft SRV — is invisible to this tooling.** It is never
read for comparison and never written.

`MANAGED_RECORDS` in `scripts/cloudflare.sh` is the **only** declaration of the
managed set. There used to be a second one, `infra/dns/hill90.com.json`; it was
deleted. Nothing read it — no script, workflow, playbook or Makefile target — so
it never drove behaviour, and it had already drifted (`admin` and `grafana`
existed in `hostinger.sh` but not in the JSON). Two sources describing the zone
that can disagree is how a host silently stops being managed; the fix is one
source, not a test keeping two in step.

## Safety contract

`cloudflare.sh` **cannot replace or delete a record it was not explicitly handed.**
That is structural, not a convention:

1. `MANAGED_RECORDS` is a literal allowlist — no wildcards, no patterns.
2. Every write goes through `cf_upsert_record()`, which takes one explicit name
   and one explicit value and touches exactly that record.
3. There is **no DELETE verb anywhere in the file**, and no bulk or
   whole-zone-replacement endpoint. Cloudflare's DNS API is per-record by
   default, so there is no zone-wide PUT to reach for.
4. Updates are `PATCH` by record id sending only `content`, so TTL, proxied
   state and any comment on the existing record are preserved.
5. If a name resolves to more than one A record, or the zone name matches more
   than one zone, the script aborts rather than guessing.

### Why this is called out

The Hostinger predecessor built the full record set as one payload and sent it to
a zone-wide `PUT`. It originally carried `overwrite: true`, which replaces the
entire zone with the payload. With 7 records in the payload against ~33 in the
zone, running it would have destroyed the `remote` A record — the only SSH path
to the VPS — along with every mail record.

That flag was removed under JON-47 and a test was added to keep it absent. The
fix was correct, but it held a dangerous shape in place by convention: the
endpoint remained *capable* of replacing the zone, and safety rested on a comment
and one assertion. The port removes the capability rather than guarding it.

## Quick Reference

```bash
make dns-view      # show the managed records as Cloudflare holds them
make dns-sync      # upsert them to the current VPS_IP / TAILSCALE_IP
make dns-verify    # check public resolution with dig
```

Or directly:

```bash
bash scripts/cloudflare.sh dns get
bash scripts/cloudflare.sh dns sync [vps_ip] [tailscale_ip]
bash scripts/cloudflare.sh dns verify [expected_ip]
```

`dns sync` reads `VPS_IP` and `TAILSCALE_IP` from SOPS when not passed as
arguments. It is idempotent — records already correct are reported `unchanged`
and not written.

### Snapshots

There is no `dns-snapshots` / `dns-restore` any more. Those wrapped Hostinger's
zone-snapshot API, which Cloudflare has no equivalent of. Cloudflare keeps
per-record change history in its dashboard, and rolling a record back is
`make dns-sync` with the right IP, because sync is idempotent and per-record.

## VPS Recreate Workflow

DNS is updated automatically as part of `make config-vps` — the `config-vps`
workflow calls `cloudflare.sh dns sync` with the new public IP and the Tailscale
IP. **Rebuild stays one command; there is no manual DNS step.** That is
deliberate: a manual step would land exactly when someone is rebuilding a dead
VPS and least able to remember it.

The workflow reads the token from the SOPS-encrypted secrets file using the age
key it has already set up. It is deliberately **not** a separate GitHub Actions
secret — one credential, one home.

## Troubleshooting

### `CF_DNS_API_TOKEN is not set and not present in ...`

Either export the token, or confirm it is in `infra/secrets/prod.enc.env`:

```bash
make secrets-view KEY=CF_DNS_API_TOKEN
```

### `Cloudflare API error ... 403`

The token is missing a permission. It needs **both** `Zone / Zone / Read` (to
resolve the zone id) and `Zone / DNS / Edit` (to write records), scoped to
`hill90.com`.

### `Expected exactly one zone named hill90.com, found 0`

The token cannot see the zone — usually because it was scoped to a different
zone, or issued on a different account.

### `Found N A records for <name>. Refusing to guess`

A second A record was added at that name, which is a valid round-robin
configuration the script cannot disambiguate. Resolve it in the Cloudflare
dashboard, then re-run.

### Records synced but not resolving

Check what the authoritative servers actually return:

```bash
dig +short traefik.hill90.com A @1.1.1.1
dig NS hill90.com +short
```

If `dig NS` still returns `ns1.dns-parking.com` / `ns2.dns-parking.com`, the
nameservers have not been moved to Cloudflare and writes are going to a zone
nobody is serving.

### CNAME vs A record conflicts

DNS forbids a CNAME coexisting with other records at the same name. `www` is a
CNAME to the apex and is not managed here; do not add an A record for it.

## Backing up the zone

There is no zone backup committed to this repository, deliberately.

Cloudflare regenerates a complete, current BIND export on demand:

```bash
curl -sS -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records/export" \
  > hill90.com.zone
```

That is a true backup of all 32 records. A committed snapshot is not: it is
correct on the day it is written and wrong from then on, and **a stale backup is
worse than no backup, because someone will trust it**. The previous one held
`remote` at a superseded Tailscale address — the record that is the only SSH path
to the box.

If you take an export, treat it as a point-in-time artifact: use it and delete
it. Do not commit it.

## Security Notes

1. **Token scope.** `Zone / DNS / Edit` permits more than the seven records this
   script touches — Cloudflare offers no per-record scope. The allowlist and the
   absent DELETE are what keep the effective blast radius small.
2. **No Global API Key.** It cannot be scoped and carries full account access.
3. **Token storage.** SOPS at rest, OpenBao at runtime. Never a plaintext file,
   and not duplicated into a workflow secret.
4. **Mail records are out of scope** and stay pointed at Hostinger.

## Reference

- Cloudflare DNS API — <https://developers.cloudflare.com/api/resources/dns/subresources/records/>
- Certificate architecture (ACME DNS-01 uses the same token) — [certificates.md](../architecture/certificates.md)
- VPS operations — [vps-operations.md](./vps-operations.md)
