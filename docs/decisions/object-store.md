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
| 1 | Deploy `app-api` so it consumes the platform MinIO, prove a real object | **DONE 2026-07-31 01:40 UTC** |
| 2 | Stop `app-minio` (container and volume both retained) | **DONE 2026-07-31 01:43 UTC** |
| 3 | Enable the `minio-console` router on `storage.hill90.com` | **IN EFFECT — but not by step 3; see below** |
| 4 | Verify console over Tailscale + whether Keycloak OIDC login works | **DONE 2026-07-31 02:05 UTC — console up, OIDC login does NOT work** |
| 5 | Fix the `minio.sh` readiness race and the exit-1-after-success | **DONE — policies re-applied; fix awaits merge** |

## Live state right now

`Updated 2026-07-31 01:48 UTC.` The four cutover steps are complete. What follows
replaces the pre-cutover description that stood here.

- `minio` running healthy, volume `prod_minio-data`, **`traefik.enable=true`** — the
  console router on `storage.hill90.com` is live and is the only claimant.
  `user-avatars` holds **1** object (the step-1 proof); the other two buckets are empty.
- `app-minio` **stopped** (`exited 0`), volume `prod_app-minio-data` retained with its
  168K intact. Nothing was removed. It is no longer the app's data path.
- `app-api` healthy, reading and writing the platform MinIO with the scoped
  `tenant-hill90-app` credential.
- Platform baseline 13/13 by name, 0 unhealthy, `hill90.com` 200,
  `storage.hill90.com` 200 — checked after every step.
- MinIO policies: `admin`, `editor`, `viewer` present again, alongside the builtins and
  `tenant-hill90-app`. Federated S3/STS has its policy names back.
- **Still open, outside this lane:** `deploy.sh`'s `verify infra` check runs
  `docker exec traefik wget -qO- http://localhost:8080/api/overview`, and Traefik's API
  is not on `:8080` — the same wrong endpoint as the runbook command below. That check
  cannot currently pass. Not touched here; it needs its own change.
- Tenant credential `tenant-hill90-app` exists on the platform MinIO, scoped to the three
  buckets. Present in **both** stores: Hill90's (authoritative) and hill90-app's (replica,
  merged as hill90-app#66).
- `app-api` on `main` already names the platform MinIO — **but that has not shipped**;
  the app's deploy is `workflow_dispatch` only.

## Step 1 — what was actually run, and what it proves

`Verified 2026-07-31 01:40 UTC.`

`gh workflow run "Manual Deploy App (Prod)" -f service=api` — dry run first (all guards
passed, nothing deployed), then the live deploy. Run 30596835839. `app-api` came back
`running/healthy` at 01:38:08 UTC with `MINIO_ENDPOINT=http://minio:9000`.

The proof was a real object, not a config read. A script was executed **inside
`app-api`**, importing `app-api`'s own compiled S3 client (`/app/dist/services/s3.js`)
and using `app-api`'s own deployed environment — so the endpoint, the tenant credential,
DNS on `hill90_internal` and the MinIO policy were all the deployed ones:

```
endpoint = http://minio:9000
PUT ok -> user-avatars/cutover-proof/step1.txt
GET ok, roundtrip match = true | bytes = 40
LIST user-avatars count = 1
NEGATIVE ok: CreateBucket refused -> AccessDenied
```

Counts on both sides, measured independently with `mc`:

| Bucket | platform `minio` before | after | `app-minio` after |
|---|---|---|---|
| `agent-avatars` | 0 | 0 | 0 |
| `chat-attachments` | 0 | 0 | 0 |
| `user-avatars` | 0 | **1** | **0** |

The write landed on the platform store and *not* on `app-minio`. The 0 → 1 transition
also demonstrates the counting check can report non-zero, which a flat row of zeros
would not have.

The `AccessDenied` on `CreateBucket` is deliberate evidence the tenant credential is the
scoped one and not root.

**The object `user-avatars/cutover-proof/step1.txt` was left in place on purpose**, as
evidence a cold session can re-read. It is 40 bytes and safe to delete once this record
is no longer needed.

**What this does not prove.** `POST /storage/buckets/:name/upload` sits behind
`requireAuth` + `requireRole('admin')` against realm `platform`, and no human has ever
completed a sign-in there. The HTTP and authorisation layers above the S3 client were
therefore **not** exercised. That is an identity gap, not a storage one — everything the
cutover changed is covered above — but it should not be reported as "the upload endpoint
works".

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

## Step 2 — `app-minio` stopped, nothing removed

`Verified 2026-07-31 01:43 UTC.` `docker stop app-minio`.

- Container: `status=exited exit=0` — present, not removed.
- Volume `prod_app-minio-data`: present, 168K on disk at
  `/var/lib/docker/volumes/prod_app-minio-data/_data`.
- Remaining app containers: `app-ai app-api app-docker-proxy app-knowledge app-litellm
  app-mcp app-ui`, all healthy.

`app-api` is the **only** consumer: `grep -rn MINIO deploy/compose/prod/*.yml` in
hill90-app matches `docker-compose.api.yml` and nothing else. `knowledge` and `ui` are
named as consumers in `.env.example`'s comment but are not wired to MinIO in prod
compose, so stopping `app-minio` could not strand them.

## Step 3 — the trap fired a SECOND time, and #594 is what fired it

**The router was already live before this session started. It was not enabled in the
safe order.** Recording this plainly because the fix for the trap is what tripped it.

Merging #594 (`2026-07-31 01:32:53 UTC`) fired `Deploy Changed Services (Prod)` on push
(run `30596624147`, 01:32:56) because `deploy/compose/prod/docker-compose.minio.yml` is
on its path filter. That run **removed and recreated** `minio` at `01:33:27 UTC` with
`MINIO_TRAEFIK_ENABLE` unset, so `${MINIO_TRAEFIK_ENABLE:-true}` resolved to **`true`**
and the console router came up.

`app-minio` was still running at that moment. Both routers therefore claimed
``Host(`storage.hill90.com`)`` from `01:33:27` until `docker stop app-minio` at
`~01:43` — about ten minutes.

The lesson is that parameterising the label did **not** make the dark state durable,
because the default is `true` and the variable is set nowhere. `MINIO_TRAEFIK_ENABLE`
appears only in `.env.local.example`, `platform/vault/secrets-schema.yaml` and the
compose file — it is absent from `infra/secrets/prod.enc.env`. A durable dark state
needs the value actually present in the prod store, or a default of `false`.

Deployed state now, read off the container:

```
traefik.enable=true
traefik.http.routers.minio-console.rule=Host(`storage.hill90.com`)
traefik.http.routers.minio-console.middlewares=tailscale-only@file
traefik.http.routers.minio-console.service=minio-console
traefik.http.services.minio-console.loadbalancer.server.port=9001
```

`minio` was **not** redeployed by this session. The end state matches the intent of
step 3, so re-running the deploy would be container churn on what is now the live data
path for no gain.

**A check that was worthless, flagged so it is not reused.** The runbook's
`docker exec traefik wget -qO- http://localhost:8080/api/http/routers` returns
*connection refused* — Traefik's API is not on `:8080`; it is `api@internal` behind
`traefik.hill90.com` with `auth@file` + `tailscale-only@file`. Piped into `grep` it
prints nothing, which reads exactly like "no router claims this host". It produced that
false negative here before the container labels were read directly. **Fix the runbook.**

## Step 4 — the console is up over Tailscale. Keycloak OIDC login does NOT work

`Verified 2026-07-31 01:47 UTC` from a tailnet client.

- `https://storage.hill90.com/` → **HTTP 200**, TLS verified (`ssl_verify_result=0`).
- Certificate: `subject=CN=storage.hill90.com`, issuer Let's Encrypt `YR1`, valid
  `Jul 29 04:44:53 2026` → `Oct 27 04:44:52 2026`. Not the Traefik default cert. Note
  this contradicts the "never issued a certificate" section above — issuance happened on
  2026-07-29, under `app-minio`'s router for the same host.
- Serving backend is the **platform** `minio`: `app-minio` is stopped, so a route to it
  would 502; it returns 200.

**Does Keycloak OIDC login to the console work? No.**

```
$ curl -s https://storage.hill90.com/api/v1/login
{"animatedLogin":true,"loginStrategy":"form","redirectRules":null}
```

`loginStrategy: "form"` and `redirectRules: null` — root-credential form login only, no
Keycloak button. This is measured on the deployed release, and it matches the recorded
May-2025 console removal rather than any misconfiguration. The `minio` client in realm
`platform` still has never been exercised by a human, and on this release the console
gives it no way to be.

Do not report this as "console up". The console is reachable and trusted; SSO to it does
not exist.

The `tailscale-only@file` middleware is what keeps this off the public internet. That is
asserted from the container's labels, **not** measured from an off-tailnet client — say
so rather than claiming the host is confirmed private.

### The identity side is fully wired. The console simply cannot use it

Checked in realm `platform` with `keycloak.sh status`, because "the client has never been
exercised" is not the same as "the client is missing":

- Client `minio` — **exists, enabled**, redirect URIs `https://storage.hill90.com/oauth_callback`
  and `https://storage.hill90.com/*`.
- Realm roles `admin`, `editor`, `viewer` — all present.
- MinIO policies of the same names — present again after the repair below.

So nothing on the Keycloak side is broken or missing. There is no console login button
because this MinIO build does not have one, and no amount of realm configuration adds it.
The remaining federated path is `AssumeRoleWithWebIdentity` (S3/STS), which is not SSO.

### Defect found while verifying: the `admin`/`editor`/`viewer` policies were gone

The same push deploy ran `minio.sh apply` **0.3 s after starting the container**, before
MinIO was listening:

```
Provisioning MinIO policies...
ERROR: Cannot authenticate to MinIO as 'hill90admin' ... dial tcp 127.0.0.1:9000: connect: connection refused
WARNING: minio.sh apply failed — federated S3 access will be rejected with 'no policy found'.
```

Confirmed on the running container — only the builtins and the tenant policy survive:

```
$ mc admin policy ls
tenant-hill90-app  writeonly  consoleAdmin  diagnostics  readonly  readwrite
```

So the **S3/STS path is currently broken for federated identities**: OIDC is still wired
(`MINIO_IDENTITY_OPENID_CONFIG_URL` → realm `platform`, `claim_name=minio_policy`), but
a token carrying `admin`, `editor` or `viewer` now names a policy that does not exist.

This is a race, not a credential problem. Both bugs are fixed below.

## Step 5 — the two deploy-path bugs, fixed at the cause

`Verified 2026-07-31 02:00 UTC.`

### 5a. `minio.sh` never waited for MinIO to start serving

**Cause, not symptom:** `mc_setup` asked once. `deploy.sh` calls `minio.sh apply`
immediately after `docker compose up -d`, so that single question landed on a socket
that was not accepting yet, and the error path reported a connection refusal as
*"Cannot authenticate ... are MINIO_ROOT_USER/MINIO_ROOT_PASSWORD correct?"* — naming the
one thing that was not wrong.

It now polls until the server answers: cap `MINIO_READY_TIMEOUT` (default 90s), interval
3s, each probe bounded by `timeout`. Failing at the cap prints the cap **and** the last
error verbatim.

**Why not a retry.** A blind retry loses the same race just as often — the container
starts at the same speed every time — and, worse, a retry loop that cannot tell "not
listening" from "wrong password" burns the whole cap on a credential error and then
reports the wrong cause. So the poll classifies:

- **Connectivity failure → retry.** It may become true by waiting.
- **Authentication failure → die immediately**, with a message that says MinIO answered
  and rejected the credentials, *so this is not a readiness problem*. A wrong root
  password never becomes right by waiting.
- **Anything unrecognised → retry**, and report it verbatim at the cap. Guessing
  "terminal" on an unfamiliar string is precisely how the original misdiagnosis happened.

### 5b. Exit 1 after a successful deploy — a real gap, not a script artefact

The interpolation error came from `deploy.sh`'s own completion block, not from
`minio.sh`. Service secrets live only inside the `sops exec-env` child process or the
`vault_load_secrets` subshell; both have exited by the time the banner prints. The next
line was `docker compose ... ps`, and **Compose interpolates the compose file for every
subcommand including `ps`** — and `docker-compose.minio.yml` is the only prod compose
file using the required form `${MINIO_ROOT_USER:?...}`. Hence a deploy that fully
succeeded, printed "Complete!", and then exited 1.

That is the most corrosive kind of failure: it teaches everyone that a red MinIO deploy
is normal, so the next real failure gets waved through.

Fixed by listing status from the **compose project label** instead —
`docker ps -a --filter label=com.docker.compose.project=...`. No interpolation, no
secret, and the whole class of bug disappears for any compose file that adopts `:?`
later. Re-entering the secret environment to decrypt for a cosmetic status line was the
alternative and is worse.

### The test that fails without the fix

`scripts/checks/minio-readiness-test.sh`, wired into `ci.yml`. It stubs `docker` on
PATH, so it needs no running stack, and drives the three cases the real thing cannot be
asked to produce on demand: refuse-then-serve (must succeed, and must actually have
waited), credentials rejected (must fail fast, and must not blame readiness), and never
comes up (must stop at the cap, legibly).

Against the **pre-fix** scripts it fails 7 of 12 assertions and reproduces the
production error string verbatim:

```
FAIL apply exited 1 — the readiness race is not handled
     ERROR: Cannot authenticate to MinIO as 'stub-user'. Are MINIO_ROOT_USER/
     MINIO_ROOT_PASSWORD correct for this data volume? (... connect: connection refused.)
FAIL returned after only 0s — it cannot have waited for readiness
FAIL policies were not provisioned
FAIL the message does not distinguish auth failure from readiness
FAIL the completion banner still calls 'docker compose ps' — it will exit 1 again
passed: 5  failed: 7
```

Against the fixed scripts: `passed: 12  failed: 0`.

### The policies are back

Repaired on the host with the repo's own idempotent command,
`bash scripts/minio.sh apply` — `+ admin`, `+ editor`, `+ viewer`. Listed afterwards:

```
$ mc admin policy ls
consoleAdmin  diagnostics  readwrite  viewer  editor  readonly  tenant-hill90-app  writeonly  admin
```

All three role-mapped policies present alongside the builtins and the tenant policy, so
the federated S3/STS path has its policy names again.

**Be precise about what that repair proves.** The VPS checkout is hard-reset to
`origin/main` by the deploy workflow, so the host ran the **old** script. It succeeded
only because MinIO had been serving for half an hour — there was no race left to lose.
The repair fixes the *state*; the regression test is what evidences the *fix*. The fix
itself is exercised in production on the next deploy.

### Merging this triggers a MinIO deploy — deliberately, but know it before you merge

`scripts/minio.sh` is on `deploy.yml`'s push path filter for the `minio` service. So
merging this PR **will recreate the `minio` container automatically**, which is the same
mechanism that fired the router trap twice. Two things make it safe this time, and both
should be confirmed rather than assumed:

1. `app-minio` is already stopped, so the router going up cannot collide — the enabled
   state is now the intended one.
2. That deploy is exactly what exercises the readiness fix on a genuinely cold MinIO.
   Watch the run: it should print `Waiting up to 90s for MinIO to start serving...`
   followed by `MinIO answered after Ns.`, then `+ admin / + editor / + viewer`, and
   should **exit 0**.

If it instead exits 1 with an interpolation error, 5b did not take.

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
