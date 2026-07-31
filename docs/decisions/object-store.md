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

> **That verification was local, and it does not hold in production today.** No user
> in the production realm `platform` holds `admin`, `editor` or `viewer`, so no
> token can name a policy and every federated exchange would be rejected with *no
> policy found*. Details and evidence in the cutover record below — read that before
> telling anyone the S3/STS path works here.

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

# CUTOVER — CLOSED 2026-07-31 02:20 UTC

`Verified 2026-07-31 02:20 UTC.` Storage consolidation is complete: the app's object
store moved up into the platform, and the app's own MinIO is retired but not yet
destroyed. The step-by-step evidence is kept below because two of the steps did not
happen the way they were planned, and that is worth being able to read back.

## What moved, what is retired, what is kept

| Thing | State | Until |
|---|---|---|
| `app-api`'s object storage | **Moved** to platform `minio` via `tenant-hill90-app` | permanent |
| Platform `minio` | **Live**, console router enabled on `storage.hill90.com` | permanent |
| `app-minio` container | **Retired — stopped, not removed** (`exited 0`, 01:40:43 UTC) | review **on or after 2026-08-01 01:41 UTC** |
| Volume `prod_app-minio-data` | **Kept**, 168K, untouched | review with the container |
| `app-minio`'s Traefik labels | **Still on the stopped container** — a restart re-collides | until the container goes |
| Keycloak console SSO | **Does not exist**, and cannot on this build | permanent |
| Federated S3/STS | Policies restored; **no user holds a mapped role** | open, see below |

**Do not remove `app-minio` or its volume before 2026-08-01 01:41 UTC.** The rule is
one full day unused. It has been stopped since 01:40:43 UTC on 2026-07-31, and `app-api`
has been serving from the platform store since 01:38 UTC. When the day is up, removing
the container is what also removes its stale `storage.hill90.com` labels — see the
hazard note below.

## Where it actually ended up

| # | Step | Status |
|---|---|---|
| 0 | Platform MinIO up, buckets mirrored, tenant credential minted | **DONE** |
| 0b | `traefik.enable` parameterised so the dark state survives a deploy | **DONE — #594, and it did not work; see step 3** |
| 1 | Deploy `app-api` so it consumes the platform MinIO, prove a real object | **DONE 01:40 UTC; RE-PROVEN 02:15 UTC after app-api was replaced** |
| 2 | Stop `app-minio` (container and volume both retained) | **DONE 2026-07-31 01:40:43 UTC** |
| 3 | Enable the `minio-console` router on `storage.hill90.com` | **DONE — but by an accidental merge-deploy, not by step 3** |
| 4 | Verify console over Tailscale + whether Keycloak OIDC login works | **DONE 2026-07-31 02:20 UTC — console up, OIDC login does NOT work** |
| 5 | Fix the `minio.sh` readiness race and the exit-1-after-success | **DONE — #595, proven on a cold MinIO 01:59 UTC** |
| 6 | Fix `verify minio`, exposed by #595 | **DONE — #597** |
| 7 | Audit `deploy.sh` for other secrets-out-of-scope sites | **DONE — one more found and fixed; two left open** |

## Re-verified 2026-07-31 02:15 UTC, after `app-api` was replaced underneath this work

An unrelated security deploy from another lane recreated `app-api` at **02:10:05 UTC**.
It picked up `main`'s compose, so it came back with `MINIO_ENDPOINT=http://minio:9000` —
the cutover configuration — but it is a **different container** from the one step 1 was
proven against. A container holding the right endpoint variable is configuration, not
traffic, so the proof was re-run rather than inherited.

Same method: a script executed **inside** the new `app-api`, importing `app-api`'s own
compiled S3 client and its own deployed environment.

```
endpoint = http://minio:9000
PUT ok -> user-avatars/cutover-proof/step1-reproof.txt
GET ok, roundtrip match = true | bytes = 40
LIST user-avatars count = 2
     cutover-proof/step1-reproof.txt 40B
     cutover-proof/step1.txt 40B
NEGATIVE ok: CreateBucket refused -> AccessDenied
```

Counts on both sides. `app-minio` is stopped, so rather than starting it — which would
recreate the router collision — its volume was read directly on disk:

| Bucket | platform `minio` (live, `mc`) | `app-minio` (volume on disk) |
|---|---|---|
| `agent-avatars` | 0 | 0 |
| `chat-attachments` | 0 | 0 |
| `user-avatars` | **2** | **0** |

Both proof objects are on the platform store; `app-minio` has received nothing. Its three
bucket directories are still present in `prod_app-minio-data` — retired, not emptied.

## Live state right now

- `minio` running healthy, volume `prod_minio-data`, **`traefik.enable=true`**.
  `user-avatars` holds **2** objects (both cutover proofs); the other two buckets are
  empty.
- `app-minio` **stopped** (`exited 0`), volume `prod_app-minio-data` retained, 168K
  intact. Nothing was removed.
- `app-api` healthy, reading and writing the platform MinIO with the scoped
  `tenant-hill90-app` credential.
- MinIO policies: `admin`, `editor`, `viewer`, `tenant-hill90-app` plus the five
  builtins — nine in total.
- `storage.hill90.com` resolves to **100.88.29.112**, a Tailscale address, where
  `hill90.com` resolves to the public `76.13.26.69`. The console is reachable over the
  tailnet and the public DNS name does not point at the public edge.
- Platform baseline 13/13 by name, 0 unhealthy, `hill90.com` 200 — checked after every
  step.

## The one live hazard left

`app-minio` is stopped but its container still carries
``traefik.http.routers...rule=Host(`storage.hill90.com`)`` and `traefik.enable=true`.
Traefik's docker provider only builds routers for **running** containers, so there is
exactly one claimant today — confirmed against the API, not inferred:

```
$ curl -s -u admin:*** https://traefik.hill90.com/api/http/routers   # 200, 3649 bytes
routers matching storage.hill90.com:
  "middlewares":["security-headers@file","tailscale-only@file"],
  "service":"minio-console","rule":"Host(`storage.hill90.com`)"
```

Only `minio-console@docker`. But **`docker start app-minio` would immediately recreate
the two-router collision**, and because both backends are MinIO the host would keep
answering 200 while silently serving from whichever router won. If anyone starts that
container to inspect the old data, stop it again before walking away.

## Still open, outside this lane

- **No Keycloak user holds a mapped realm role**, so the federated S3/STS path cannot
  resolve a policy for anybody. Detail in step 4. This is a role-assignment decision,
  not a bug to quietly fix.
- `deploy.sh`'s `verify infra` check runs
  `docker exec traefik wget -qO- http://localhost:8080/api/overview`. Traefik's API is
  not on `:8080` — it is `api@internal` behind `traefik.hill90.com`. That check cannot
  pass. Same wrong endpoint as the old runbook command. Untouched here.
- MinIO community edition looks like it is in maintenance; Garage and SeaweedFS are the
  named alternatives. Recorded above, still not decided.

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

Re-measured at 02:20 UTC after the #595 merge-deploy recreated the container: identical.
The console has no OIDC entry point at all — `/api/v1/login/oauth2/auth` → **404**,
`/api/v1/login/detail` → **404**. (`/oauth_callback` returns 200, but so does every
path: it is the SPA shell, not a handler.)

### Reachability is over Tailscale, and that part is measured

`storage.hill90.com` resolves to **100.88.29.112** — a Tailscale CGNAT address — while
`hill90.com` resolves to the public **76.13.26.69**. The successful request went to
100.88.29.112. So the console is served over the tailnet and the public name does not
point at the public edge, which is a stronger statement than "the middleware is
configured". The `tailscale-only@file` middleware is applied on top; that part is read
from Traefik's API, not tested from an off-tailnet client.

### Keycloak would authenticate. The console has nowhere to send you

"The client has never been exercised" is not the same as "the client is broken", so the
client was exercised as far as it can be without a human password:

```
GET https://auth.hill90.com/realms/platform/protocol/openid-connect/auth
      ?client_id=minio&response_type=code&scope=openid
      &redirect_uri=https%3A%2F%2Fstorage.hill90.com%2Foauth_callback
-> HTTP 200,  <title>Sign in to Hill90 Platform</title>,  "Sign in to your account"
```

Keycloak serves a real login page for the `minio` client. The identity provider side
works. The client is enabled, `standardFlowEnabled: true`, with both redirect URIs, and
its `realm-roles` mapper emits `claim.name: minio_policy` — exactly the claim
`MINIO_IDENTITY_OPENID_CLAIM_NAME` tells MinIO to read.

**So the failure is entirely on the MinIO side, and it is a missing feature rather than
a misconfiguration.** Nothing in the realm can add a login button to a build that ships
without one.

### The finding that would otherwise have surfaced next month: nobody holds a role

The policies are back, but a token still could not name one, because **no user in realm
`platform` holds any mapped realm role**:

```
users in realm platform, with their realm roles:
  hill90admin: default-roles-platform
  jon:         default-roles-platform
  testuser01:  default-roles-platform
groups: (none)
```

The realm roles `admin`, `editor` and `viewer` all exist; nobody is assigned any of
them. So `minio_policy` would arrive carrying only `default-roles-platform`, which is
not a MinIO policy, and `AssumeRoleWithWebIdentity` would be rejected with *no policy
found* — the same symptom as the missing-policies defect, from an entirely different
cause. Repairing the policies did not make the federated path usable, and reporting
"policies restored, S3/STS fixed" would have been wrong.

**Deliberately not fixed here.** Granting a realm role is handing out `s3:*` plus
`admin:*` on the platform object store; that is Jon's decision, not a repair to slip
into a storage PR. It is also why the end-to-end exchange in the runbook could not be
demonstrated: to mint a token at all you would need `directAccessGrantsEnabled` on the
`minio` client, which is **false** by design in `keycloak.sh` — the only supported path
is a browser sign-in, and there is no user whose token would resolve.

What *is* proven, rather than inferred: the policy documents are correct and complete.

```
$ mc admin policy info admin
{"PolicyName":"admin","Policy":{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::*"]},
  {"Effect":"Allow","Action":["admin:*"]}]}}
```

Note the two separate statements — MinIO rejects `s3:*` inside a statement containing
any `admin:` action, so this shape is load-bearing.

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

### 5c. Both fixes proven in production on a genuinely cold MinIO

`#595 merged; push deploy run 30597770315, 2026-07-31 01:59 UTC.` This is the real
test — the container was destroyed and recreated, so the race was live:

```
01:59:31.83  Container minio Started
01:59:31.84  Provisioning MinIO policies...
01:59:32.17  Waiting up to 90s for MinIO to start serving...
01:59:35.29  MinIO answered after 3s.
01:59:35.52  = admin
01:59:35.63  = editor
01:59:35.74  = viewer
01:59:35.74  Policies provisioned.
01:59:35.74  Object Store Deployment Complete!
01:59:35.79  NAMES               STATUS                            PORTS
             minio               Up 4 seconds (health: starting)   9000/tcp
             postgres            Up 53 minutes (healthy)           5432/tcp
             ...
```

Read what that shows. The container needed **3 seconds** to start serving, and the old
code asked at 0.3s — which is exactly why it failed and why it failed with an
authentication error. **5a is proven, not merely unobserved.**

And 5b is proven the same way: the line that used to abort the script is the
`NAMES / STATUS / PORTS` listing at 01:59:35.79. It ran, it printed, and no
`required variable MINIO_ROOT_USER is missing a value` followed it. The evidence is
positive — the previously-failing statement executed and produced output — not merely an
absent error message.

### 5d. Fixing 5b exposed a third instance of the same class: `verify minio`

The deploy step now exits 0, so the workflow reached its **next** step for the first
time — and that one failed, 30 attempts against a MinIO that was healthy throughout:

```
Run: ssh ... "cd /opt/hill90/app && bash scripts/deploy.sh verify minio"
Verifying readiness: minio (prod)
  Waiting for minio... (1/30) ... (30/30)
✗ minio failed readiness check after 30 attempts
running (health: healthy)          <- the diagnostic block's own verdict
```

Same root cause, third location. `cmd_verify`'s check interpolated
`${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}`, but the workflow invokes it as a **bare**
`ssh ... bash scripts/deploy.sh verify minio` with no `sops exec-env` wrapper. Confirmed
on the host rather than reasoned about:

```
$ [ -z "${MINIO_ROOT_USER:-}" ] && echo EMPTY
EMPTY
$ docker exec -e MC_HOST_local="http://:@127.0.0.1:9000" minio mc admin info local
mc: <ERROR> Unable to get service info. Access Denied.
```

It built `http://:@127.0.0.1:9000` and MinIO correctly refused an anonymous caller.

**This was not introduced by #595 — it was uncovered by it.** The deploy step used to
exit 1 before verify ever ran, so the check had presumably never once passed. It was
also flagged and set aside in the previous session's report as "a separate concern";
that was a miss, and the cost was one red deploy.

Fixed by delegating to `minio.sh status`, which resolves the credentials itself
(environment, else SOPS) and, since #595, waits for readiness. The inner wait is capped
at 5s because `cmd_verify`'s own 30-attempt loop is already the retry mechanism —
nesting a 90s wait inside it would turn a failure into a ten-minute silence. Verified
against the live host:

```
$ MINIO_READY_TIMEOUT=5 MINIO_READY_INTERVAL=1 bash scripts/minio.sh status; echo $?
0                                          <- the new check
$ timeout 15 docker exec -e MC_HOST_local="http://${MINIO_ROOT_USER}:..." ...; echo $?
1                                          <- the old check, same moment, same MinIO
```

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

## What is left

The cutover itself is finished. Three things remain, none of them blocking:

```bash
# 1. ON OR AFTER 2026-08-01 01:41 UTC — one full day unused — remove app-minio.
#    Removing the container is also what removes its stale storage.hill90.com
#    labels, which are the last live hazard. Check first that nothing regressed:
docker logs app-api --since 24h | grep -i 'minio\|s3' | head
docker rm app-minio                    # container only, deliberately
#    The VOLUME is a separate, later decision. prod_app-minio-data holds 168K and
#    the buckets were empty; back it up before it goes, per the guardrail that a
#    routine operation must never be able to destroy data.

# 2. Decide whether anyone should hold realm role admin/editor/viewer. Until
#    someone does, federated S3/STS resolves no policy for any human. This is a
#    privilege grant, not a repair — see step 4.

# 3. Merge the `verify minio` fix (step 5d). Until then the MinIO deploy job goes
#    red at its last step even when the deploy itself succeeded.
```

Baseline by name after every step: 13 present, 0 unhealthy, `hill90.com` 200.

## The pattern: code paths that need secrets, running where the secrets are not

`Audited 2026-07-31 02:20 UTC.` Three bugs in three days were the same shape, so
`deploy.sh` was audited for the rest rather than waiting for a fourth to bite.

The shape: **service secrets exist only inside a `sops exec-env` child process or a
`vault_load_secrets` subshell.** Anything outside those — a bare `ssh ... deploy.sh
verify`, a line after the subshell closes, a function that never loads secrets at all —
sees them as empty. Bash does not complain about an empty variable, so the failure
surfaces somewhere unrelated and usually blames something else.

Docker Compose makes it sharper: **it interpolates the compose file for every
subcommand**, including `ps` and `down`, not just `up`. And
`docker-compose.minio.yml` is the only prod compose file using the required form
`${VAR:?...}`, which is why MinIO is where this keeps surfacing — everywhere else the
same mistake interpolates to empty and says nothing.

| # | Site | Status |
|---|---|---|
| 1 | Completion banner `docker compose ps` (`cmd_service`) | **Fixed #595** |
| 2 | `cmd_verify` minio check interpolating `${MINIO_ROOT_USER}` | **Fixed #597** |
| 3 | `cmd_teardown` `docker compose down` | **Fixed here** |
| 4 | `${DB_USER:-hill90}` in `cmd_verify` and `cmd_service` | **Fixed — sweep** |
| 5 | `.htpasswd` written with no empty-check (`cmd_infra`) | **Fixed — sweep** |
| 6 | `cmd_infra`'s completion `docker compose ps` | **Fixed — sweep**; #595 fixed only the `cmd_service` copy |
| 7 | `validate.sh compose` reporting a valid file as `✗ Invalid` | **Fixed — sweep** |

The sweep was done by property, not memory: enumerate every `docker compose` invocation
and every credential-shaped interpolation across `scripts/`, then check which run bare.
That is how 6 and 7 turned up — neither was on anyone's list. The rule now lives in
[the deployment runbook](../runbooks/deployment.md#secrets-and-the-shells-that-do-not-have-them)
rather than being re-derived each time.

Two sites were checked and are **not** instances: `local.sh` passes `--env-file`, which
supplies values by a different and correct mechanism, and the `docker compose` mention in
`preflight-edge.sh` is inside an error message, not an invocation.

### 3. `deploy.sh teardown minio` could not run at all

`cmd_teardown` loads no secrets. Proven read-only — `config` exercises the identical
interpolation stage that `down` must pass, and running `down --dry-run` against a live
production stack was deliberately not done:

```
$ docker compose -p hill90-prod-platform -f docker-compose.minio.yml config
rc=1   required variable MINIO_ROOT_USER

$ sops exec-env infra/secrets/prod.enc.env "docker compose ... config"
rc=0   errors=0
```

Worse than it looks: it fails **after** `backup.sh` has run and after printing
`Volumes: KEPT — data survives`, so the operator sees a backup, sees a reassuring
message, and gets a failure that reads like it happened during teardown rather than
instead of it.

Fixed by wrapping the `down` in `sops exec-env`, with `set -e` inside the string —
without it `exec-env` returns 0 whatever the command did, and a failed teardown would
report success. That trap is already documented on `_deploy_infra_with_sops`; it is the
same one.

### 4. `${DB_USER:-hill90}` — works today for a reason that is not guaranteed

`cmd_verify`'s db check and `cmd_service`'s auth precondition both run outside the
secret environment, so `DB_USER` is empty and the literal fallback `hill90` is what is
actually used. It passes:

```
$ bash scripts/deploy.sh verify db
✓ db is healthy
$ docker inspect postgres --format '...' | grep POSTGRES_USER
POSTGRES_USER=hill90
```

It works only because the hardcoded fallback happens to equal the real `POSTGRES_USER`.
Change `DB_USER` in the store without editing this literal and the check queries a role
that does not exist — and the auth precondition would refuse to deploy Keycloak with a
message blaming Postgres. **Not fixed**: the correct fix is either to load the secret or
to drop the fallback so the mismatch is loud, and that is a decision about the db path,
not a storage change.

### 5. The `.htpasswd` write has no empty guard

`cmd_infra` writes `echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > .htpasswd`. Both
copies are correctly **inside** the secret scope, so this is not the scope bug — but
neither checks the value is non-empty, and an empty one writes `admin:` over the live
dashboard credential. `keycloak.sh` guards exactly this case
(*"Refusing to write an empty client secret"*); `deploy.sh` does not. **Not fixed** —
edge deploys are a different blast radius and deserve their own change.

## Checks that lie, collected

Every one of these returned a confident, wrong answer during this work. They are
recorded together because the failure mode is identical each time — a check that cannot
distinguish "no" from "could not ask".

| Check | What it looks like | What it is |
|---|---|---|
| `docker exec traefik wget -qO- localhost:8080/api/http/routers \| grep host` | "no router claims this host" | connection refused, piped into grep. The API is `api@internal` behind `traefik.hill90.com` |
| `mc ls -r alias/bucket \| wc -l` with a wrong alias | "0 objects" | alias does not exist; the error went to stderr and was not counted |
| `head -c 40 file \| grep -q 'ENC\['` | "the file is plaintext" | the file was zero bytes. Absence of an encryption marker is not presence of a secret |
| `grep 'docker compose.*ps' deploy.sh` | "the bug is still there" | it matched the comment explaining the fix |
| `ls -l platform/edge/dynamic/` | "`.htpasswd` is missing — dashboard auth will break on restart" | `ls -l` does not list dotfiles. The file was there all along. Use `ls -la` |
| `grep -oE 'VAR:-[0-9]+' \| cut -d- -f3` | "the value is unset" | the name has no hyphen, so `:-120` splits into two fields and `-f3` is empty |
| `grep -oE 'The "VAR" variable is not set'` | "compose is silent about it" | compose escapes the quotes (`\"VAR\"`); there were 14 warnings |

Two of those are from checks written *while* cataloguing this failure mode, which is the
point: the reflex to trust a command that returned nothing is very hard to unlearn. The
rule that actually works is to make the check produce a **positive** result on a known
input before believing a negative one on an unknown.

The working version of the first one, for the runbook:

```bash
# From a tailnet client, through the real API, with the dashboard credential in a
# mode-600 curl config file rather than on the command line.
curl -s -K "$cfg" https://traefik.hill90.com/api/http/routers | tr '{' '\n' | grep storage
```
