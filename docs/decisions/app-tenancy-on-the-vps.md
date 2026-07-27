# What Hill90 Must Provide for a Tenant App Deployment on the VPS

**Status:** assessment — no change made, nothing deployed
**Recorded:** 2026-07-27
**Scope:** the Hill90 side only. The app-side work is tracked in
`hill90-app` under
[docs/decisions/running-the-app-on-hill90-infra.md](https://github.com/jonhill90/hill90-app/blob/main/docs/decisions/running-the-app-on-hill90-infra.md).

## Context

`hill90-app` is a tenant of Hill90, not a peer. Its
`deploy/compose/prod/*.yml` declare `hill90_edge` and `hill90_internal` as
`external: true`, and Hill90's `deploy/compose/prod/docker-compose.infra.yml`
is what creates them. Nothing in that repo can start until Hill90's infra is
up.

That makes "can the app be deployed to the VPS" partly a Hill90 question. This
document answers the Hill90 half: what the platform already provides, what it
does not, and what has to be built or decided before a first tenant deploy is
possible.

Every claim below was verified by running a command on 2026-07-27. Where
something is inferred rather than observed, it says so. **No change was made to
production and nothing was deployed.** Every VPS command used was read-only.

## Answers, in short

| Question | Answer |
|---|---|
| Do the app's hostnames have DNS? | **Yes**, all of them, and they point where they should. But none are managed by Hill90's DNS tooling. |
| Do they have certificates? | **`auth` yes, the rest no.** No Hill90 change is needed — HTTP-01 is proven working and issues on first router. |
| Does Traefik need configuration? | **Essentially no.** Production has no provider constraints, so it discovers tenant containers automatically. One middleware reference is undefined and must be resolved. |
| Does deploy tooling know about tenants? | **No.** The concept does not exist in either repo. It needs building, and the recommendation is to build it in `hill90-app`, not here. |

The blockers that remain are name collisions, not platform capability. Hill90
already provides almost everything a tenant deployment needs.

## 1. DNS and certificates

### The records exist and are correct

The VPS public address is `76.13.26.69`:

```
$ dig +short srv1264324.hstgr.cloud @1.1.1.1
76.13.26.69
```

Every hostname the app's prod compose files ask for resolves, and each resolves
to the address matching its intended exposure:

```
$ for h in hill90.com www.hill90.com api.hill90.com ai.hill90.com \
           auth.hill90.com litellm.hill90.com storage.hill90.com; do
      printf "%-24s %s\n" "$h" "$(dig +short A $h @1.1.1.1 | tr '\n' ' ')"
  done
hill90.com               76.13.26.69
www.hill90.com           hill90.com. 76.13.26.69
api.hill90.com           76.13.26.69
ai.hill90.com            76.13.26.69
auth.hill90.com          76.13.26.69
litellm.hill90.com       100.88.29.112
storage.hill90.com       100.88.29.112
```

The public five point at the VPS public IP; `litellm` and `storage` point at
the Tailscale address, which is consistent with their compose labels applying
`tailscale-only@file`. So the DNS layer is not a blocker for any app hostname.

They are also **not Cloudflare-proxied**. A proxied record answers with a
Cloudflare anycast address, not the origin; these answer with the origin. That
matters because it is what leaves HTTP-01 unobstructed. This is inferred from
the resolution above rather than read from the Cloudflare API — no token was
loaded for this assessment.

### But Hill90's DNS tooling does not know they exist

`scripts/cloudflare.sh` writes an explicit allowlist and nothing else
(`scripts/cloudflare.sh:54-62`):

```bash
MANAGED_RECORDS=(
    "@:vps"
    "remote:tailscale"
    "vps:tailscale"
    "portainer:tailscale"
    "traefik:tailscale"
    "grafana:tailscale"
    "vault:tailscale"
)
```

None of `www`, `api`, `ai`, `auth`, `litellm` or `storage` appear. The script's
safety contract states that anything not named there "is invisible to it — it
is never read for comparison and never written". So:

- No Hill90 code path created these records. They predate the app strip or were
  set by hand.
- `cloudflare.sh dns verify` will report all-clear while an app record is
  missing or wrong, because it only checks the seven it manages.
- A VPS rebuild that re-runs `cloudflare.sh dns sync` restores the seven managed
  records and **not** the app's. That is a real gap in
  [vps-rebuild.md](../runbooks/vps-rebuild.md)'s coverage once the app is live.

Extending `MANAGED_RECORDS` is a small change, but it widens the set of records
a script can write, so it belongs in its own reviewed change rather than folded
into a deploy. It is not a blocker for a first deploy — the records are already
correct.

### Certificates: one issued, four not, and no Hill90 change required

Read directly from Traefik's ACME stores on the VPS:

```
$ ssh deploy@100.88.29.112 'docker exec traefik cat /letsencrypt/acme.json'
 resolver: letsencrypt
    auth.hill90.com

$ ssh deploy@100.88.29.112 'docker exec traefik cat /letsencrypt/acme-dns.json'
 resolver: letsencrypt-dns
    portainer.hill90.com
    grafana.hill90.com
    vault.hill90.com
    traefik.hill90.com
```

Confirmed from outside, against the origin:

| Hostname | Certificate served |
|---|---|
| `auth.hill90.com` | `CN=auth.hill90.com`, issuer `Let's Encrypt YR2`, valid 2026-07-26 → 2026-10-24 |
| `hill90.com` | `CN=TRAEFIK DEFAULT CERT` |
| `www.hill90.com` | `CN=TRAEFIK DEFAULT CERT` |
| `api.hill90.com` | `CN=TRAEFIK DEFAULT CERT` |
| `ai.hill90.com` | `CN=TRAEFIK DEFAULT CERT` |

`TRAEFIK DEFAULT CERT` is the self-signed placeholder Traefik serves when no
router matches the SNI. It confirms both facts at once: no certificate, and no
router.

**The important finding is that HTTP-01 already works on this Traefik.**
`auth.hill90.com` sits in `acme.json`, which is the storage for the
`letsencrypt` resolver, and that resolver's only challenge is
`httpChallenge` on the `web` entrypoint (`platform/edge/traefik.yml.tmpl`).
So the path is not theoretical — it has issued a production certificate on this
host, on this Traefik version, through this firewall.

The preconditions are still in place. Port 80 is reachable from the public
internet, and the ACME challenge path is exempt from the HTTPS redirect:

```
$ curl -sI http://api.hill90.com/.well-known/acme-challenge/x | head -1
HTTP/1.1 404 Not Found
$ curl -sI http://api.hill90.com/anything | head -1
HTTP/1.1 308 Permanent Redirect
```

The 404 is Traefik's ACME handler answering with no challenge pending; the 308
is the `web` entrypoint's global redirect. If the redirect swallowed the
challenge path, both would be 308 and HTTP-01 would be impossible. It does not.

**Therefore: `api`, `ai`, `hill90.com` and `www` need no Hill90 action to get
certificates.** They issue automatically the first time a router carrying
`tls.certresolver=letsencrypt` appears for them, which the app's compose labels
already do (`docker-compose.api.yml:135`, `docker-compose.ui.yml:46`,
`docker-compose.mcp.yml:46`). The resolver names the app requests —
`letsencrypt` and `letsencrypt-dns` — are both defined here, and the template
notes that resolver names are a contract precisely so this keeps holding.

Two things to respect rather than fix:

- **Rate limits.** 50 certificates per registered domain per week, 5 failed
  validations per hostname per hour. Four new hostnames is well inside that. A
  crash-looping deploy that repeatedly fails validation is not — that is 5
  attempts before a lockout, and it is the realistic way to hit it.
- **The records must stay unproxied and port 80 must stay open.** Both are true
  today and neither is asserted by any check in this repo.

### `auth.hill90.com` is contested, and that is the real certificate finding

Hill90's own Keycloak owns `auth.hill90.com` today — it holds the certificate,
it is running, and it is routed. The app's `docker-compose.auth.yml:56` declares
`Host(`auth.hill90.com`)` for *its* Keycloak.

This is not a certificate problem. It is the hostname half of the collision set
described in §2 below, and it cannot be resolved by anything in the certificate
layer.

## 2. Traefik configuration

**Short answer: production Traefik needs no configuration change to route to
containers it does not yet know about.** It will discover them automatically.
Three details qualify that.

### Discovery already works, and it works because production has no constraints

The production static config (`platform/edge/traefik.yml.tmpl`, and verified in
the live container) sets:

```yaml
providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: hill90_edge
```

There is no `constraints` key. The Docker provider reads the socket directly,
so it sees every container on the host regardless of which Compose project or
which repository started it. A tenant container with `traefik.enable=true` on
`hill90_edge` is routed with no Hill90-side change at all.

This is deliberate and documented — the local config *does* carry constraints,
and says why (`platform/edge/traefik.local.yml:72-89`): a developer Mac has
neighbouring stacks on the same socket, and "production has no such neighbours,
so it does not need this and does not have it". Deploying a tenant makes
production have neighbours for the first time. The current behaviour is what
the app needs, so nothing changes now, but the stated premise is no longer
true and that comment will mislead the next reader.

Traefik itself is attached only to `edge`
(`deploy/compose/prod/docker-compose.infra.yml:47-48`), which is the network the
app's routed services join. The network exists on the VPS, along with the other
two the app declares external:

```
$ ssh deploy@100.88.29.112 'docker network ls --format "{{.Name}}"'
hill90_agent_internal
hill90_edge
hill90_internal
hill90-prod-platform_default
```

`hill90_agent_sandbox` and `hill90_docker_proxy` are absent, correctly — the app
creates those itself.

### `traefik.docker.network` is not needed on the VPS

The app's containers are multi-homed (`edge` plus `internal`, and for some
`agent_internal`), which normally forces an explicit
`traefik.docker.network` label so Traefik picks the right IP. Here the
provider-level `network: hill90_edge` supplies that default globally, and on the
VPS `NETWORK_PREFIX` is unset so `hill90_edge` is the real name. No label is
required.

This is a VPS-specific answer. Locally the same key reads `hill90dev_edge` and
the parity check enforces that it tracks `NETWORK_PREFIX`, which is the app
repo's problem, not this one.

### `mcp-strip@file` is referenced by the app and does not exist here

This is the one required decision on the Traefik side.

`hill90-app/deploy/compose/prod/docker-compose.mcp.yml:48` sets:

```
traefik.http.routers.mcp.middlewares=mcp-strip@file
```

Hill90 defines six file middlewares, and that is not one of them. Verified both
in the repo and in the running container:

```
$ ssh deploy@100.88.29.112 \
    'docker exec traefik grep -E "^    [a-z-]+:" /etc/traefik/dynamic/middlewares.yml'
    security-headers:
    rate-limit:
    auth:
    tailscale-only:
    compress:
    cors:
```

A router naming a middleware that is defined nowhere does not fall back to no
middleware — Traefik puts the router into an error state and it serves nothing.
So `ai.hill90.com/mcp` would fail even with DNS, certificate and container all
correct.

The other two file middlewares the app references are present: `rate-limit@file`
(`docker-compose.ui.yml:48`) and `tailscale-only@file`
(`docker-compose.ai.yml:55`).

**Recommendation: the app declares `mcp-strip` as a label, not Hill90 as a
file.** Hill90 removed it during the strip because it is an app concern — a path
prefix strip for one app's routes — and re-adding it would put app-specific
routing knowledge back into platform config. The app's local overlay already
declares it as a label, so the pattern exists and works; it needs carrying into
the prod compose file. That change belongs to the app-arch lane.

### One leftover worth noting

`platform/edge/dynamic/middlewares.yml` still defines a `cors` middleware whose
`accessControlAllowOriginList` is `https://hill90.com` — the app's origin.
Nothing references it. It is harmless, but it is app-specific config surviving in
platform config, which is exactly what the `mcp-strip` recommendation above
argues against. Candidate for cleanup, not a blocker.

### The collisions Traefik will not protect against

Traefik router names are global across the whole Docker provider. Comparing the
two repos:

| Router name | Hill90 | hill90-app |
|---|---|---|
| `keycloak` | ✓ (`docker-compose.auth.yml`) | ✓ (`docker-compose.auth.yml`) |
| `minio-console` | ✓ **once PR #556 merges** | ✓ (`docker-compose.minio.yml`) |
| `traefik`, `portainer`, `grafana`, `vault` | ✓ | — |
| `api`, `ui`, `mcp`, `litellm` | — | ✓ |

Two containers defining the same router name means one silently wins, and which
one is not deterministic across restarts. Combined with `container_name` and
hostname collisions, the full contested set is:

| Name | Container | Router | Hostname | Status |
|---|---|---|---|---|
| Keycloak | `keycloak` | `keycloak` | `auth.hill90.com` | contested **today** |
| Postgres | `postgres` | — | — | contested **today** |
| postgres-exporter | `postgres-exporter` | — | — | contested **today** |
| MinIO | `minio` | `minio-console` | `storage.hill90.com` | contested **once PR #556 merges** |

The MinIO row is new information for the app lane. `hill90-app`'s decision
record states "Hill90 runs no MinIO — nothing to dedup", which was true when
written. PR #556 restores MinIO on `feat/restore-minio` with
`container_name: ${CONTAINER_PREFIX:-}minio`, router `minio-console` and
`Host(`${MINIO_HOST:-storage}.${BASE_DOMAIN:-hill90.com}`)` — the same three
names the app uses. That PR is open and deliberately held; this changes nothing
about whether to merge it, but the app lane should stop treating MinIO as
uncontested.

The container-name collisions fail safe: Docker refuses to start a second
container with an existing name, so the app's `auth` and `db` stacks cannot
start on the VPS at all. The router-name collision does **not** fail safe, and
the hostname collision does not either.

## 3. Deploy tooling

**Short answer: no. Neither repo has any concept of deploying a tenant
application, and it has to be built.**

### Hill90's deploy CLI is closed over its own stacks

`scripts/deploy.sh` accepts a fixed set of verbs (`scripts/deploy.sh:14-33`,
dispatched at `:518`):

```
Commands:
  infra    Deploy infrastructure (Traefik, Portainer)
  db       Deploy PostgreSQL (platform database)
  auth     Deploy Keycloak (platform identity provider)
  vault    Deploy OpenBao secrets management
  observability  Deploy observability stack
  teardown Stop and remove a stack's containers and networks
  verify   Run post-deploy readiness check for a service
  backup   Run pre-deploy backup for a service
```

Anything else exits non-zero. More structurally, every code path computes its
compose file as `deploy/compose/${env}/docker-compose.${stack}.yml` — a fixed
layout inside this repository. There is no parameter, environment variable or
code path by which it deploys a compose file from anywhere else. `cmd_teardown`
(`:461`) and `cmd_verify` (`:50`) both carry the same closed allowlist.

The CI side matches. `.github/workflows/deploy.yml` filters on four compose
files and three `platform/` subtrees, and its `workflow_dispatch` choice list is
`[all, db, auth, vault, observability]`. Every deploy workflow checks out this
repository only; none clones a second one. Adding a tenant is a new workflow,
not a new path-filter entry.

### The app side has nothing at all

```
$ ls hill90-app/scripts
local.sh  provision-akm-db.sh  provision-litellm-db.sh
$ ls hill90-app/scripts/deploy.sh
ls: scripts/deploy.sh: No such file or directory
$ ls hill90-app/infra/secrets
ls: cannot access 'infra/secrets': No such file or directory
```

No deploy script, no secrets store, no age key, no vault AppRole. The app has a
local development path and nothing else. So the gap is not "Hill90 lacks a
tenant verb" — it is that the entire deploy path for the app is unbuilt.

### Recommendation: build it in `hill90-app`, not here

Extending Hill90's `deploy.sh` with a `tenant` verb is the smaller-looking
change and the wrong one.

Every safety property in that script is written around stacks it owns: the
vault-first/SOPS-fallback authentication resolves against
`infra/secrets/${env}.enc.env` and a per-service Hill90 AppRole; `backup.sh`
knows the volume names of the five platform stacks; `cmd_teardown` maps stacks
to Compose project names so that a `down` cannot reach into a neighbouring
stack. A tenant verb would need a second secrets source, a second compose root,
a second backup inventory and a second project-name map — at which point it is
a second script living inside the first one, sharing only the parts that make it
dangerous.

The tenancy contract Hill90 actually offers is narrow and already met: the three
external networks, the edge proxy with its resolvers and middlewares, and the
host. A tenant deploy script belongs with the tenant, and should depend on that
contract rather than extend the tooling that provides it.

What Hill90 could usefully add instead is a **preflight the tenant can call** —
a read-only assertion that the three networks exist, Traefik is up, and the
required file middlewares are defined. That is a genuine platform
responsibility, it is small, and it converts the failure mode from the app's
observed "network hill90_edge declared as external, but could not be found"
into a named contract violation. It is not a blocker for a first deploy.

### An existing check that cannot pass

Not caused by the tenant work, but it sits directly in the path any tenant
tooling would copy. `deploy.sh verify infra` runs:

```bash
docker exec traefik wget -qO- http://localhost:8080/api/overview
```

Traefik's static config sets `api.insecure: false`, so nothing listens on 8080.
Observed:

```
$ ssh deploy@100.88.29.112 'docker exec traefik wget -qO- http://localhost:8080/api/overview'
wget: can't connect to remote host: Connection refused
```

That check can only ever time out and exit 1. It is not currently reached by the
deploy workflows, which do not verify `infra`. Worth fixing separately.

## What Hill90 must provide — the contract

| Requirement | Provided today | Action |
|---|---|---|
| `hill90_edge` exists | ✓ | none |
| `hill90_internal` exists | ✓ | none |
| `hill90_agent_internal` exists | ✓ | none |
| Traefik discovers tenant containers | ✓ (no provider constraints) | none |
| Traefik resolves the right IP for multi-homed containers | ✓ (`network: hill90_edge`) | none |
| `letsencrypt` resolver (HTTP-01) | ✓ proven, issued `auth` | none |
| `letsencrypt-dns` resolver (DNS-01) | ✓ proven, four certs | none |
| Port 80 open, ACME path unredirected | ✓ | none |
| DNS for `hill90.com`, `www`, `api`, `ai` | ✓ resolves, unproxied | none to deploy; add to `MANAGED_RECORDS` separately |
| `rate-limit@file` | ✓ | none |
| `tailscale-only@file` | ✓ | none |
| `security-headers@file` | ✓ (entrypoint-wide) | none |
| `mcp-strip@file` | ✗ | app declares it as a label |
| `auth.hill90.com` free for the app | ✗ Hill90's Keycloak holds it | naming decision, app lane |
| Container names `keycloak`, `postgres`, `postgres-exporter` free | ✗ | naming decision, app lane |
| Container name `minio`, router `minio-console`, host `storage` free | ✗ once PR #556 merges | naming decision, app lane |
| Tenant deploy tooling | ✗ | build in `hill90-app`; optionally add a preflight here |
| Tenant secrets store | ✗ (app has none) | app lane |
| Observability of tenant containers | partial — `cadvisor` scrapes all containers; no app-specific Prometheus job | not a blocker |

Nothing in the "Provided today ✗" column is a Hill90 capability gap except the
deploy tooling. The rest are naming decisions that belong to the app.

## VPS baseline, captured during this assessment

Unchanged from the app repo's Phase 0 baseline, re-verified read-only:

```
13 containers, 0 unhealthy
cadvisor grafana keycloak loki node-exporter openbao portainer
postgres postgres-exporter prometheus promtail tempo traefik

hill90_edge members: keycloak openbao grafana portainer prometheus traefik
```

`portainer` and `traefik` report no health status because they declare no
healthcheck, not because they are failing.

## Known-unverified

- **No issuance was attempted.** That HTTP-01 will succeed for `api`, `ai`,
  `hill90.com` and `www` is inferred from it having succeeded for
  `auth.hill90.com` through the same resolver on the same host, plus the live
  port-80 and challenge-path probes. It is a strong inference, not an
  observation. The first real test is the first deploy.
- **Cloudflare proxy status is inferred from resolution**, not read from the
  Cloudflare API. No API token was loaded for this assessment.
- **Firewall rules were not enumerated.** `firewall-cmd --list-ports` returned
  nothing over the SSH chain. Ports 80 and 443 are known reachable because they
  were reached from the public internet, which is the property that matters.
- **Router-name collision behaviour is asserted from Traefik's documented
  model**, not reproduced. Reproducing it would mean starting a colliding
  container in production, which was out of scope.
- **Whether the app's `internal`-only services need egress** was not assessed
  here. Hill90's `internal` network is `internal: true`, so anything needing
  outbound must also attach to `edge`. The app repo has this documented in its
  local overlay and has not yet hit it in prod.
- **No tenant preflight was written.** The recommendation in §3 is a proposal.
