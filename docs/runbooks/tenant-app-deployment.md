# Deploying hill90-app to the VPS — What Would Have to Happen

**Status:** partially executed — Phase A complete; `ui`, `db`, `auth` and `api`
deployed 2026-07-29 from hill90-app's own pipeline
**Recorded:** 2026-07-27
**Updated:** 2026-07-29
**Companion to:** [app-tenancy-on-the-vps.md](../decisions/app-tenancy-on-the-vps.md),
which establishes what Hill90 provides. This turns that into an ordered
procedure.

The plan below was written from read-only probes and has since been partly
carried out. What is now deployed and healthy: `ui`, `db`, `auth`, `api`.
`knowledge` is crash-looping and `ai` is unhealthy — the `knowledge` fix is
merged to hill90-app's `main` but not yet deployed. `mcp` and `minio` have never
been deployed. Deploys run from hill90-app's GitHub Actions pipeline over SSH,
never from a workstation.

## Bottom line

**The app has no deployment path because one was never built, not because
Hill90 cannot host it.** That is the honest headline, and it should be said
before anyone attempts a deploy and discovers it step by step.

Two questions were open. Both are now settled:

- **Can `ai` and `api` get certificates?** **Yes.** Every precondition for
  HTTP-01 is verified, and every one of them is identical to `auth.hill90.com`,
  which already holds a certificate from the same resolver. This is no longer an
  assumption of symmetry — the symmetry was measured. See §1.
- **Can Hill90's deploy tooling deploy a tenant?** **No, and neither can
  hill90-app's, because it has none.** This needs building. See §2.

The platform side is in better shape than the tooling side. Of the sixteen
things a tenant deploy needs from Hill90, thirteen already exist. What is
missing is the deploy path itself and a set of naming decisions.

## 1. The certificate question, settled

The concern was that `ai` and `api` are public hosts, so they need HTTP-01,
whereas the hosts that demonstrably have certificates today — `portainer`,
`grafana`, `vault`, `traefik` — are Tailscale-only and went through DNS-01. A
different challenge type is a different failure surface, and assuming symmetry
with the DNS-01 hosts would prove nothing.

That framing is right, but it points at the wrong comparator. **`auth.hill90.com`
is the correct one: it is public, and it holds a certificate issued through
HTTP-01 on this Traefik.**

```
$ ssh deploy@<vps> 'docker exec traefik cat /letsencrypt/acme.json'
resolver: letsencrypt          <- httpChallenge on entrypoint web
  auth.hill90.com

$ ssh deploy@<vps> 'docker exec traefik cat /letsencrypt/acme-dns.json'
resolver: letsencrypt-dns      <- dnsChallenge, cloudflare
  portainer.hill90.com  grafana.hill90.com  vault.hill90.com  traefik.hill90.com
```

So HTTP-01 is a proven path on this host, not a theoretical one. The remaining
question is narrow and answerable: **does `api` or `ai` differ from `auth` in any
way that HTTP-01 depends on?** Each dependency was checked separately.

| Precondition | `auth` (has cert) | `api` | `ai` | Method |
|---|---|---|---|---|
| Resolves to the VPS | 76.13.26.69 | 76.13.26.69 | 76.13.26.69 | `dig` |
| Record type | A | A | A | `dig` — no CNAME indirection |
| Cloudflare proxy | `proxied=false` | `proxied=false` | `proxied=false` | Cloudflare API |
| Resolver agreement | 4/4 | 4/4 | 4/4 | 1.1.1.1, 8.8.8.8, 9.9.9.9, 208.67.222.222 |
| CAA restriction | none | none | none | `dig CAA` at FQDN, apex and TLD |
| Port 80 reachable | yes | yes | yes | `curl` from off-network |
| ACME path exempt from redirect | 404 | 404 | 404 | see below |
| Other paths redirected | 301 | 301 | 301 | see below |
| ACME account | valid, prod LE, acct `3571664055` | same account | same account | `acme.json` |
| Resolver defined | `letsencrypt` | `letsencrypt` | `letsencrypt-dns` (litellm) / `letsencrypt` (mcp) | `traefik.yml.tmpl` |

The decisive measurement is the last pair, run per-host against the VPS:

```
$ for h in auth api ai hill90.com www; do ... done
  auth.hill90.com      acme=404 other=301
  api.hill90.com       acme=404 other=301
  ai.hill90.com        acme=404 other=301
  hill90.com           acme=404 other=301
  www.hill90.com       acme=404 other=301
```

The `web` entrypoint redirects everything permanently to `websecure` — except
`/.well-known/acme-challenge/`, which Traefik's ACME handler intercepts and
answers 404 when no token is pending. **If that exemption were missing, the
challenge would be redirected to HTTPS, Let's Encrypt would not follow it, and
HTTP-01 would be impossible.** It is present, and it is present identically for
every one of the five hostnames. `api` and `ai` are indistinguishable from the
host that already works.

Two further checks that could each have been a silent blocker:

- **CAA.** No CAA record exists at `api.hill90.com`, `ai.hill90.com`,
  `hill90.com`, or `com`. An unnoticed CAA record is a classic cause of
  "inexplicable" issuance failure, and it can differ per subdomain. There is
  none, so no CA is restricted.
- **Cloudflare proxy status**, read from the API rather than inferred from
  resolution: every A record in the zone is `proxied=false`. A proxied record
  would put Cloudflare in the path on port 80 and change the validation
  entirely.

`www.hill90.com` is a CNAME to the apex, also unproxied. HTTP-01 handles CNAMEs
without special treatment.

### What is still not proven, and what the real risk is

**No certificate was issued, because issuance requires a router to exist, which
requires a deploy.** Every input to HTTP-01 has been verified; the act itself
has not been performed. That is the honest limit of this analysis.

The residual risk is therefore not "will HTTP-01 work" — it is **rate limits if
something else goes wrong**. Let's Encrypt allows 5 failed validations per
hostname per hour and 50 certificates per registered domain per week. Four new
hostnames is trivially inside the weekly limit. A crash-looping container that
Traefik keeps re-requesting for is not: that is five attempts before an hour-long
lockout, and it is the realistic way this bites.

**Mitigation, and it is the one genuinely valuable precaution in this whole
plan:** issue against the Let's Encrypt **staging** CA first. The mechanism
already exists and is deliberate — `ACME_CA_SERVER` has no default,
`render-traefik-config.sh` refuses to render without it, and
`ACME_REQUIRE_PRODUCTION=1` exists to prevent the opposite mistake. Staging has
far looser limits, so a broken first deploy costs nothing.

The cost of that path is real and must be understood before choosing it:
switching CAs means Traefik will **not** reissue certificates it considers
valid, so returning to production requires clearing the ACME stores — and
`acme-dns.json` holds all four DNS-01 certificates in one file. Staging-testing
the app's HTTP-01 certificates therefore risks the *working* infra certificates
if the stores are cleared carelessly. `docs/architecture/certificates.md` covers
the recovery.

Given that trade, the recommendation is: **go straight to production ACME, but
deploy one service first** (`ui` at `hill90.com`), confirm the certificate, and
only then bring up the rest. One hostname's worth of rate limit is a cheaper
experiment than a CA switch.

## 2. The deploy tooling question, settled

**Hill90's deploy tooling cannot deploy a tenant application, and hill90-app has
no deploy tooling at all. This has to be built. It is the single largest piece
of unstarted work, and it is the actual reason the app has no deployment path.**

### Hill90's side is closed over its own stacks

`scripts/deploy.sh` takes a fixed verb set — `infra`, `db`, `auth`, `vault`,
`observability`, `teardown`, `verify`, `backup` — and the dispatcher rejects
anything else. More structurally, every path computes its compose file as
`deploy/compose/${env}/docker-compose.${stack}.yml`, a fixed layout inside this
repository. There is no parameter, environment variable or code path that points
it at a compose file from elsewhere. `cmd_teardown` and `cmd_verify` carry the
same closed allowlist independently.

CI matches: every deploy workflow checks out this repository only, and
`deploy.yml`'s `workflow_dispatch` choice list is `[all, db, auth, vault,
observability]`. Adding a tenant is a new workflow, not a path-filter entry.

### The app's side is empty

```
$ ls hill90-app/scripts
local.sh  provision-akm-db.sh  provision-litellm-db.sh
$ ls hill90-app/scripts/deploy.sh
No such file or directory
$ ls hill90-app/infra/secrets
No such file or directory
```

No deploy script, no secrets store, no age key, no vault AppRole, no CI deploy
workflow. `RESURRECTION.md` §2 states this plainly and has been right the whole
time: "The deploy tooling — `scripts/deploy.sh`, the `Makefile` targets, and the
per-service GitHub Actions deploy workflows all stayed in Hill90."

And there is no checkout on the host. `/opt/hill90/app` is a **Hill90** clone
despite the name:

```
$ ssh deploy@<vps> 'cd /opt/hill90/app && git remote -v'
origin  https://github.com/jonhill90/Hill90.git
```

### Where it should be built, and why not here

**Build it in `hill90-app`.** Extending Hill90's `deploy.sh` with a `tenant`
verb looks smaller and is the wrong shape.

Every safety property in that script is written around stacks it owns. The
vault-first/SOPS-fallback path authenticates with a per-service Hill90 AppRole
against `infra/secrets/${env}.enc.env`. `backup.sh` knows the volume names of
the five platform stacks. `cmd_teardown` maps stacks to Compose project names
specifically so a `down` cannot reach into a neighbouring stack — and the repo
bans `--remove-orphans` for the same reason. A tenant verb needs a second
secrets source, a second compose root, a second backup inventory and a second
project-name map. At that point it is a second script living inside the first,
sharing only the parts that make it dangerous.

The tenancy contract Hill90 offers is narrow and already met: three external
networks, an edge proxy with working resolvers and middlewares, and a host with
capacity. A tenant's deploy script should depend on that contract, not extend
the tooling that provides it.

**What Hill90 should add is one small thing: a read-only preflight** the tenant
calls before deploying — assert the three networks exist, Traefik is running,
and the file middlewares the tenant references are defined. That converts the
app's observed failure

```
network hill90_edge declared as external, but could not be found
```

into a named contract violation, and it is a genuine platform responsibility.
It is not a blocker; it is the cheapest thing on this list.

## 3. The ordered plan

Risk labels: **[SAFE]** reversible, no production impact. **[CARE]** touches
production but fails safe. **[RISK]** can break a working Hill90 surface —
named individually in §4.

### Phase A — app-side prerequisites (no VPS contact)

Owned by the app-arch lane. Nothing else can start until these land.

1. **[SAFE] Resolve the name collisions.** Four contested names, in `container_name`,
   Traefik router name, and hostname. This is a design decision, not a rename:
   whether the app's data plane should sit on its own network rather than
   `hill90_internal` is part of it.

   | Name | Container | Router | Hostname |
   |---|---|---|---|
   | Keycloak | `keycloak` | `keycloak` | `auth.hill90.com` |
   | Postgres | `postgres` | — | — |
   | postgres-exporter | `postgres-exporter` | — | — |
   | MinIO | `minio` | `minio-console` | `storage.hill90.com` |

   The MinIO row becomes contested when #556 merges; it is not today.
   `postgres-exporter` should be deleted rather than renamed — Hill90 owns
   observability and already runs one.

   *Verify:* no name in the app's prod compose appears in Hill90's, checked
   across all three namespaces.

2. **[SAFE] Fix `mcp-strip`.** The app's `docker-compose.mcp.yml` references
   `mcp-strip@file`, which Hill90 does not define. A router naming an undefined
   middleware does not degrade — it errors and serves nothing. Declare it as a
   label, as the local overlay already does.

   *Verify:* the prod compose has no `@file` reference Hill90 does not define.
   Currently the app references three; two exist.

3. **[SAFE] Parameterise the five network names.** 23 literals across nine files.
   Three are Hill90's (`edge`, `internal`, `agent_internal`); two are the app's
   own (`agent_sandbox`, `docker_proxy`) and need it too, because
   `services/api` attaches agent containers by name.

4. **[SAFE] Build the deploy script and the secrets store.** §2. This is the
   long pole. It needs, at minimum: a compose root, a secrets source, a
   dependency-ordered bring-up, a per-service readiness check, and a teardown
   that cannot reach outside its own project.

5. **[SAFE] Fix the two dead provision scripts.** Both `source` a
   `scripts/_common.sh` that was never extracted, so both die at line 7 under
   `set -e`. `provision-akm-db.sh` additionally pipes a heredoc into
   `docker exec` without `-i`. Fix the missing file first — it masks the other.

### Phase B — Hill90-side preparation

6. **[SAFE] Add a tenant preflight** to Hill90 (§2). Read-only.

7. **[SAFE] Add the app's hostnames to `cloudflare.sh`'s `MANAGED_RECORDS`.**
   The records are already correct, so this changes nothing today. It matters
   for VPS rebuild: `dns sync` currently restores seven records and not the
   app's, and `dns verify` reports all-clear while an app record is wrong.
   Do this as its own reviewed change — it widens the set of records a script
   can write, which is the property `cloudflare.sh`'s safety contract exists to
   constrain.

8. **[CARE] Decide who owns `auth.hill90.com`.** Hill90's Keycloak holds it and
   the certificate today. It cannot be shared. Until this is decided the app's
   auth stack cannot be deployed at all — see §4.1.

### Phase C — first deploy

9. **[CARE] Get the app onto the host.** Clone to a path that is not
   `/opt/hill90/app` — that is Hill90's checkout despite the name. Capacity is
   not a constraint: 187G free of 199G, 12G RAM available of 15G.

10. **[CARE] Seed the app's secrets**, by whatever mechanism Phase A step 4
    chose. If it is vault, this needs an AppRole and a policy, which is a Hill90
    change.

11. **[CARE] Provision the app's databases** in the app's own Postgres. That is
    still what this sequence does, and it is unchanged.

    *Amended 2026-07-30:* the reason given here — "Hill90's health check asserts
    platform-only databases" — is no longer the reason. That check now asserts
    tenant isolation and accepts a properly provisioned tenant; Hill90 gained
    `scripts/provision-tenant-db.sh` for exactly this. Putting the app's
    databases on the platform is a real option, and a separate decision. See
    [../decisions/tenant-databases-on-platform-postgres.md](../decisions/tenant-databases-on-platform-postgres.md).

12. **[RISK] Deploy `ui` alone, and stop.** This is the certificate experiment
    and the first live routing test in one. `ui` is the right first service: it
    has no dependency on the contested Keycloak, and `hill90.com` is currently
    unrouted so there is nothing to displace.

    *Verify:* `curl -sI https://hill90.com` returns a real certificate rather
    than `CN=TRAEFIK DEFAULT CERT`; `acme.json` gains `hill90.com`; the four
    existing DNS-01 certificates are untouched.

    **Stop here and confirm before continuing.** This single step answers the
    only genuinely unproven question in this document.

13. **[RISK] Deploy the remainder in dependency order.** `api` must precede `ai`
    and `knowledge` — it is the sole creator of `agent_sandbox` and
    `docker_proxy`, which those two consume as external.

    Order: `db` → `auth` → `api` → `ai`, `knowledge`, `mcp` → `minio`.

14. **[SAFE] Verify the Hill90 baseline is unchanged.** 13 containers, 0
    unhealthy; `auth.hill90.com`, `grafana`, `portainer`, `vault` and `traefik`
    all still serving. Run this after *every* step above, not only at the end.

## 4. Risk register — the steps that can break production

### 4.1 Deploying the app's auth stack can take down infra admin SSO — **highest**

`auth.hill90.com` is Hill90's Keycloak, and it is the identity provider for
Grafana, Portainer and Vault SSO. The app declares the same hostname *and* the
same Traefik router name (`keycloak`).

The `container_name` collision fails safe — Docker refuses a duplicate name, so
the stack cannot start. **The router-name collision does not.** If the container
is renamed but the router is not, two containers define a router called
`keycloak` and Traefik picks one non-deterministically across restarts. The
losing router is not logged as an error; it is simply absent.

The failure mode is: infra SSO breaks at an unpredictable time, for a reason
that appears nowhere, triggered by an unrelated restart.

*Do not deploy the app's auth stack until §3 step 1 is complete and verified
across all three namespaces.*

### 4.2 There is no staging step — anything that starts is immediately public

Production Traefik sets no provider `constraints`, so the Docker provider picks
up **every** container on the socket regardless of Compose project. The moment a
container starts with `traefik.enable=true` and a `Host` rule, it is live on the
public internet. There is no dry-run, no disabled state, no review gate.

This is exactly the property that makes the tenant model work with no Traefik
configuration — and the same property means a mistake is instantly exposed.
Bring services up one at a time.

### 4.3 The `postgres` network alias collides silently on shared networks

Observed locally: two containers aliased `postgres` on one network made DNS
return both addresses, and Keycloak resolved to the wrong instance and failed
authentication with `FATAL: password authentication failed for user "hill90"` —
a message that reads as a secrets problem and is not.

Because DNS returns both, it is non-deterministic and will intermittently
succeed, which is the worst available failure mode. If the app's data plane
shares `hill90_internal`, this reaches production.

### 4.4 Certificate rate limits, if a deploy crash-loops

5 failed validations per hostname per hour. See §1. Mitigated by step 12's
one-service-first approach.

### 4.5 Merging anything under the deploy workflow's path filter fires an
unattended production deploy

`deploy.yml` triggers on push to `main` for `platform/auth/keycloak/**`,
`platform/data/postgres/**`, `platform/observability/**`, and four compose
files. This is how PR #556 came to be held — it touches
`platform/observability/prometheus/prometheus.yml`. Any Hill90-side change in
this plan needs the same check before merge.

### 4.6 Observability cardinality

`cadvisor` scrapes every container on the host, so nine new containers appear in
Prometheus without configuration. That is desirable, but it is a step change in
series count on a stack sized for 13 containers. Low severity; worth watching
rather than pre-empting.

## 5. What this plan does not cover

- **Whether the app works.** No routed surface of the app has ever been reached
  in production, and nothing here proves the app is correct — only that it can
  be deployed and reached.
- **Data migration.** The app's databases would be provisioned empty. Whether
  anything needs restoring into them is not addressed.
- **`services/cli` and `services/discord-bot`**, which per `RESURRECTION.md` §6
  have never been part of any automated deploy.
- **Rollback.** Hill90's `rollback.sh` knows its own stacks only, with the same
  closed allowlist as `deploy.sh`. A tenant rollback path is part of the tooling
  that needs building, and is not designed here.

## 6. Evidence

Every command in this document was read-only. Commands shown against the VPS were
run over `ssh -i ~/.ssh/remote.hill90.com deploy@100.88.29.112`.

- Certificate stores: `docker exec traefik cat /letsencrypt/acme.json`,
  `/letsencrypt/acme-dns.json`
- DNS: `dig` against 1.1.1.1, 8.8.8.8, 9.9.9.9, 208.67.222.222; CAA at FQDN,
  apex and TLD
- Cloudflare proxy status: `GET /zones/{id}/dns_records`, token from SOPS
- Port 80 / ACME path: `curl` from off-network against 76.13.26.69 with explicit
  `Host` headers
- Host capacity: `df -h /`, `free -h`
- Tooling: `scripts/deploy.sh`, `.github/workflows/deploy.yml`,
  `ls hill90-app/scripts`
