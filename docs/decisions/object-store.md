# The object store: MinIO restored, with its limits recorded

**Status:** decided. MinIO is restored as a platform service.
**Related:** [platform-primitives.md](platform-primitives.md), issues #530, #538.

## What was decided

MinIO comes back as a **platform primitive** — the open-source counterpart to an
Azure Storage Account, alongside Keycloak for Entra ID and OpenBao for Key Vault.
It is pinned to the current release, its OIDC is wired to Keycloak for the
S3/STS path, and its console login is root credentials only.

## There is no consumer today

Stated plainly because it is the most likely thing to be misread later:

- Loki is configured with `filesystem` storage and `object_store: filesystem`.
- Tempo is configured with `backend: local`.
- `backup.sh` writes volume tars to disk and has no S3 target.

Nothing in this repository reads or writes an object store. The primitive exists
so that consumers can arrive, which is the same reasoning that restored Keycloak
and Postgres in #531. The four `MINIO_*` and `VAULT_MINIO_*` keys that survived
in `prod.enc.env` were orphans of the extracted application; they are live again
rather than newly minted.

The concrete problem this also solves: `storage.hill90.com` has resolved to the
VPS throughout, so the platform has been advertising an object store that nothing
served.

## OIDC works. SSO does not. The difference matters

**MinIO removed the management console from the AGPL community build in May
2025.** Verified by running releases side by side against a real Keycloak with
identical configuration:

| Release | Console `loginStrategy` |
|---|---|
| `RELEASE.2025-04-22` | `redirect` — a working Keycloak button |
| `RELEASE.2025-05-24` | `form` |
| `RELEASE.2025-06-13` | `form` |
| `RELEASE.2025-07-23` | `form` |
| `RELEASE.2025-09-07` | `form` |

So on any current release the console offers **only** root-credential form login,
no matter how OIDC is configured. `redirectRules` is `null`.

What OIDC still provides is the **S3/STS path**: `AssumeRoleWithWebIdentity`
accepts a Keycloak token and returns temporary S3 credentials carrying the
policy named in the token's claim. That was verified end to end — a Keycloak user
with realm role `admin` obtained credentials and wrote an object.

**This is not SSO and must not be described as SSO.** It closes the MinIO part of
issue #530 only in the sense that the identity provider is genuinely wired in;
nobody gets a login button.

### Why not pin the April release

Considered and rejected. Keeping the login button would mean freezing an
internet-facing service on a build that stops receiving security updates, with no
upgrade path that preserves the feature. A login button is not worth that.

## The community edition looks like it is in maintenance

**Flagged for Jon, not acted on.** `minio/minio:latest` resolves to
`RELEASE.2025-09-07`, roughly ten months old at the time of writing. Combined
with the console removal and the general push toward the commercial AIStor
product, the community edition appears to be receiving little investment.

If the Storage Account role should be filled by something actively developed,
**Garage** and **SeaweedFS** are the obvious candidates. That is a real decision
with real migration cost and it deserves its own decision record — it is
deliberately *not* smuggled into this change. This note exists so the question is
on the record rather than discovered later.

## The policy namespace is shared, and that is a sharp edge

Realm role names map directly onto MinIO policy names, and MinIO's built-in
policies — `consoleAdmin`, `readwrite`, `readonly`, `writeonly`, `diagnostics` —
live in the same namespace. Today `REALM_ROLES` is fixed at `admin editor
viewer`, so there is no collision.

**A future realm role named `consoleAdmin` would silently grant MinIO admin** to
anyone holding it, without anything in this repository changing. If the realm
role set grows, check it against MinIO's built-ins first.

## Certificate path

`storage.hill90.com` has **never issued a certificate** under the current ACME
configuration — see issue #538. The cause is not a broken ACME path: there was no
Traefik router for the host, so nothing ever asked. Traefik serves its default
self-signed certificate for hostnames it has no router for, which is correct
behaviour.

Restoring the service adds that router, so this deploy is the **first issuance**
for the host. Two consequences:

1. **This must deploy after the Cloudflare ACME migration (#535).** `main` still
   configures DNS-01 through the `httpreq` provider pointed at the
   `dns-manager` Hostinger shim, while the zone is now served by Cloudflare. A
   DNS-01 challenge would write a TXT record to a zone Hostinger no longer
   answers for, validation would fail, and `storage.hill90.com` would serve
   Traefik's default certificate — exactly the untrusted-certificate state this
   work is meant to end.
2. The resolver is **not hardcoded**. The router inherits `ADMIN_CERT_RESOLVER`
   like every other admin surface, so whichever provider is live applies.

The first issuance should be watched rather than assumed. Procedure in
[the runbook](../runbooks/object-store.md).

The stale `_acme-challenge.storage` TXT record in the zone is a fossil from when
MinIO last existed; it survives because `dns-manager`'s `/cleanup` has never
successfully deleted a record. Retiring it is #538's business, not this change's.

---

# CUTOVER STATE — read this first if you are picking this up

`Last updated 2026-07-31 ~01:30 UTC.` Written deliberately so a context exhaustion or a
handover cannot leave storage half cut over with nobody knowing which half.

## Where it actually is

| # | Step | Status |
|---|---|---|
| 0 | Platform MinIO up, buckets mirrored, tenant credential minted | **DONE** |
| 0b | `traefik.enable` parameterised so the dark state survives a deploy | **DONE — this PR** |
| 1 | Deploy `app-api` so it consumes the platform MinIO, prove a real object | **NOT DONE** |
| 2 | Stop `app-minio` (container and volume both retained) | **NOT DONE** |
| 3 | Enable the `minio-console` router on `storage.hill90.com` | **NOT DONE** |
| 4 | Verify console over Tailscale + whether Keycloak OIDC login works | **NOT DONE** |

## Live state right now

- `minio` running healthy, volume `prod_minio-data`, **`traefik.enable=false`**, three
  buckets (`agent-avatars`, `chat-attachments`, `user-avatars`), **0 objects**.
- `app-minio` running, volume `prod_app-minio-data` intact, still the app's live data
  path, still the only enabled router for `storage.hill90.com`.
- Platform baseline 13/13 by name, 0 unhealthy, `hill90.com` 200.
- Tenant credential `tenant-hill90-app` exists on the platform MinIO, scoped to the three
  buckets. Present in **both** stores: Hill90's (authoritative) and hill90-app's (replica,
  merged as hill90-app#66).
- `app-api` on `main` already names the platform MinIO — **but that has not shipped**;
  the app's deploy is `workflow_dispatch` only.

## The trap that already fired once

Merging any change to `deploy/compose/prod/docker-compose.minio.yml` **redeploys minio**
(`deploy.yml` triggers on those paths — invariant 1). On 2026-07-31 that silently
re-enabled the router while `app-minio` still claimed the same Host rule, giving two
routers one rule with no provider constraints to disambiguate. It was restored by hand.

That is why the label is now `${MINIO_TRAEFIK_ENABLE:-true}`. **During the remaining
cutover, deploy minio with `MINIO_TRAEFIK_ENABLE=false`** until step 2 is done.

Note both backends are MinIO, so `storage.hill90.com` returns 200 either way — an
ambiguous route does not announce itself. If it points at the platform store before the
app has cut over, an operator sees an **empty** bucket list and may conclude data was
lost. It was not; the data path is still `app-minio`.

## To continue

```bash
# 1. deploy app-api (pipeline only; dry run first)
gh workflow run "Manual Deploy App (Prod)" -f service=api -f dry_run=true
gh workflow run "Manual Deploy App (Prod)" -f service=api

# prove it, do not infer from config: write through the APP's own path, then read the
# object back from the platform MinIO and compare counts on both sides. They were both
# 0, so a 0 -> 1 landing in the right bucket is the proof.

# 2. stop app-minio — STOP only. Do not rm, do not touch prod_app-minio-data.
docker stop app-minio

# 3. only now let the router go live
bash scripts/deploy.sh minio prod      # MINIO_TRAEFIK_ENABLE unset -> true

# 4. verify over Tailscale, and say plainly whether Keycloak OIDC login WORKS.
#    The `minio` client in realm platform has never been exercised by a human.
#    MinIO's AGPL build has no console SSO since May 2025 — the console offers
#    root-credential form login only, and OIDC gates the S3/STS path. Report what
#    is actually true rather than "console up".
```

Baseline by name after every step: 13 present, 0 unhealthy, `hill90.com` 200.
