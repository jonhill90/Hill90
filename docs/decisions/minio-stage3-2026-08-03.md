# MinIO Stage 3: what MinIO does with a multi-valued claim, and the remedy that follows

`Measured 2026-08-03 against MinIO RELEASE.2025-09-07T16-13-09Z — the deployed image.`
Behaviour was established **before** an approach was chosen, on a throwaway MinIO of the same
image using real tokens for `jon`. **Production MinIO was not modified.**

Closes the question in [#641](https://github.com/jonhill90/Hill90/issues/641).

## What was measured

`jon`'s token from the `minio` client carries:

```
minio_policy : ['offline_access', 'platform-admin', 'uma_authorization', 'default-roles-platform']
type         : list  (a JSON array, not a comma-separated string)
```

Against production MinIO, STS refuses:

```
InvalidParameterValue: None of the given policies
(`default-roles-platform,offline_access,platform-admin,uma_authorization`)
are defined, credentials will not be generated
```

The word **"None"** is the clue, and it was tested rather than trusted. On a throwaway MinIO:

| Experiment | Result |
|---|---|
| no claim value names a policy | **refused** — reproduces production |
| **one** value names a policy (2 of 4 still name nothing) | **credentials issued** |
| **two** values name policies — one list-only, one put-only | issued, and `jon` could **both list and write** |

**So: unknown values are ignored, matching values are applied, and multiple matches are
UNIONED.** MinIO's documentation says the claim may be a string or an array of policy names;
what it does not say is how it treats a mixture of known and unknown, which is the case that
actually occurs here.

## The sharp edge, which is the union rule

Every token in realm `platform` carries `offline_access`, `uma_authorization` and
`default-roles-${realm}` — Keycloak grants them to **every** account. Combined with the union
rule:

> **A MinIO policy named after any universally-held realm role is granted to every user who
> can log in**, with no role assignment anywhere and nothing to see in Keycloak.

This is not theoretical. In the experiment above, policies named `uma_authorization` and
`offline_access` gave `jon` list and write **purely for being a member of the realm**.

`scripts/checks/minio-policy-names-test.sh` fails on exactly that collision. Run against
production it reports **no universal collisions today**.

## The remedy, chosen after the measurement

**Create MinIO policies named after the Stage-1 realm roles: `platform-admin` and
`platform-viewer`.** This is option 1 from #641 — but it is now chosen because the mechanism
was measured, and with a constraint the issue did not state: *never name a policy after a role
Keycloak grants automatically.*

The alternatives, and why not:

- **A different mapper type.** A hardcoded-claim mapper emits the same value for everyone, so
  it cannot express two tiers. A user-attribute mapper works but abandons the role-driven
  model Stages 1 and 2 established, and puts the authorisation decision in a per-user
  attribute nobody reviews.
- **Renaming the claim or the mapper.** #635 already established the claim name is consistent
  end to end. Nothing there is broken.

## Proof — real S3 operations as `jon`, not a config read

An instrument note first, because two earlier attempts produced confident nonsense: harnesses
built on `mc` reported *admin denied under `admin:*`* and *delete allowed under a read-only
policy*, and a **bogus identity as ALLOWED**. `mc alias set` has no `--session-token` flag, so
the alias carried no token and every call authenticated as nobody. The results were replaced,
not explained away. The final harness signs S3 requests directly and reports HTTP status —
200/204 allow, 403 deny — and proves itself on a known-good and a known-bad identity before
any verdict is read:

```
POSITIVE root list-buckets     ALLOWED  200
NEGATIVE bogus list-buckets    DENIED   403
```

With a policy named `platform-admin` (body byte-identical to the existing `admin` policy),
`jon`'s real token, through STS:

```
list-buckets     ALLOWED  200
list-objects     ALLOWED  200
write            ALLOWED  200      <- an object written as jon
read             ALLOWED  200      <- and read back
make-bucket      ALLOWED  200
delete           ALLOWED  204
admin-info       ALLOWED  200
admin-policies   ALLOWED  200
```

**Listing and writing both succeed** — a read-only success would have hidden a policy granting
too little, which is why both were required.

## What `jon` can NOT do — stated plainly, because this is the failure nobody notices

**Inside MinIO: nothing.** `platform-admin` as shipped is `s3:*` on every bucket plus
`admin:*`. Concretely `jon` can delete the tenant's `tenant-hill90-app` bucket and its
contents, create and remove any bucket, read every object of every tenant, and use the admin
API — including changing MinIO's own OIDC configuration, which is the escalation path worth
naming out loud.

Two things bound it, and neither is a permission:

1. **The S3 API has no Traefik router.** Only `minio-console` is published
   (`Host(storage.hill90.com)`, port 9001, `tailscale-only`). The STS endpoint used for this
   proof is reachable only from inside the Docker network — the proof ran against the
   container IP. So the grant is not exposed to the internet today.
2. **The AGPL console has no SSO login** (recorded in `scripts/minio.sh`'s header), so this
   path is S3/STS only.

**That the body is byte-identical to the existing `admin` policy is deliberate: this
introduces no new privilege tier, it makes the existing top tier reachable by the role that
actually has holders.** If a narrower `platform-admin` is wanted — `s3:*` without `admin:*`,
which would still pass the list-and-write proof above and would remove the
change-the-identity-config path — that is a one-line change to `policy_json` and a decision
for Jon, not one to make silently inside a Stage-3 ticket.

The enforcement is real rather than vacuous, which was proven separately by giving
`platform-admin` a read-only body:

```
list-buckets   ALLOWED  200
read-seed      ALLOWED  200
write          DENIED   403  Access Denied.
delete         DENIED   403  Access Denied.
admin-info     DENIED   403
```

## Legacy policies `admin`, `editor`, `viewer` — a live over-grant path, not removed here

They are named after the Stage-0 realm roles, which have **zero holders**, so they are
unreachable today. The moment anyone is granted realm role `admin`, they receive MinIO
`admin` — `s3:*` plus `admin:*` — silently. `minio.sh` still creates them because production
already has them and removing a policy is a separate, irreversible decision; the new check
**warns** about each one. Retiring them is the obvious follow-up and is deliberately not done
in this PR.

## The vault guard, checked rather than assumed

`minio` declares **no** vault paths, and `vault_load_secrets` used to `return 0` for that
case — exporting nothing and reporting success. That is the same silent-empty class as the
2026-08-03 auth outage, one level up: the deploy's vault branch then ran `docker compose`
with an entirely empty environment.

**`minio` survived it only by accident**, because `docker-compose.minio.yml` writes
`${MINIO_ROOT_USER:?...}` and compose failed, tripping the fallback. That is a second guard
doing the first guard's job, and not every compose file has one.

Fixed: a service with no declared paths now returns non-zero and routes to SOPS explicitly.
Covered by `tests/scripts/vault-empty-guard.bats`, which now has 11 tests including the
`set -e`-suppression trap from #652.

## What is NOT done, and needs a pipeline deploy

The policies do not exist in production yet. `deploy.sh` runs `minio.sh apply` after a
`minio` deploy, so this lands with `gh workflow run deploy-minio.yml` **after merge** — the
pipeline deploys `origin/main`. Until then production STS still refuses `jon`, exactly as
measured at the top of this document.

**The proof above is on an identical throwaway instance with real tokens, not on production.**
That distinction is the whole difference between "this design works" and "this is live", and
this document claims only the first.
