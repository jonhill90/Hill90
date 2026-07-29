# Pre-deploy impact — hill90-app, #21 through #35

**Companion to [the morning brief](2026-07-29-morning-brief.md) §4.1.** What
actually changes in the running system if you deploy. Measured 2026-07-29
08:30 UTC.

## The short answer

**Nothing user-visible changes except where `api` and `mcp` fetch their JWKS.**

One environment variable disappears from two containers, one appears on a third,
and the fourth is a byte-for-byte no-op. Everything else in the fifteen commits is
documentation, tests, CI, scripts, or code whose behaviour the running
configuration does not expose.

The one change with teeth is that **token validation moves from an internal URL
to the public issuer through Traefik**, which makes the edge a dependency of
authentication. That is §3 below.

## Method, and why it is trustworthy

Reading the diff tells you what the author intended. Inspecting the container
tells you what is true. This compares both, and **where they disagree the
container wins**:

- `docker compose config` rendered from `main` (`fb90223`) with the real
  production secrets, locally.
- `docker inspect` of each running container on the VPS.
- The same render at the deployed commit (`f882158`) to separate "the author
  changed this" from "this differs at runtime".

Read-only throughout: nothing was deployed, restarted, created, or written on the
host. Container count held at 23 with the Hill90 baseline at 13.

One artefact to ignore if you re-run this: rendering locally resolves relative
bind mounts to the local checkout, so `volumes` appear to differ. On the VPS both
resolve under `/opt/hill90-app` — confirmed by `docker inspect`. It is a
rendering artefact, not a change.

## 1. Per-stack impact

| Container | Env delta | Image | Recreated? |
|---|---|---|---|
| `app-api` | **−`KEYCLOAK_JWKS_URI`** | rebuilds (6 source files) | **yes** |
| `app-mcp` | **−`KEYCLOAK_JWKS_URI`** | unchanged (0 source files) | **yes** — env change alone |
| `app-ui` | **+`KC_REALM=hill90`** | rebuilds (6 source files) | **yes** |
| `app-keycloak` | none | unchanged | **no** — see §4 |

Everything else was compared and is identical between the running container and
the render from `main`: `command`, `image` reference, `healthcheck`, Traefik
labels, and mount targets. `ai`, `knowledge`, `litellm`, `minio`, `postgres` and
`docker-proxy` are untouched by these commits.

`app-ui` gaining `KC_REALM` is inert today: it resolves to `hill90`, which is
what the previously hardcoded value already was. It exists so the realm becomes a
knob for the Keycloak migration.

## 2. `#22` — store keys removed. Confirmed no-op.

`AUTH_KEYCLOAK_ISSUER` and `AUTH_URL` were removed from the SOPS store because
nothing read them.

**Nothing at runtime expected them from the store.** Both are still set on
`app-ui`, composed by `docker-compose.ui.yml` from `APP_AUTH_HOST`, `BASE_DOMAIN`
and `KC_REALM`, and the rendered values are **identical** to what the running
container holds:

```
AUTH_KEYCLOAK_ISSUER = https://app-auth.hill90.com/realms/hill90
AUTH_URL             = https://hill90.com
```

No container gains or loses either variable. Safe.

## 3. `#26` — JWKS moves onto the public issuer. **This is the one to weigh.**

The hardcoded `KEYCLOAK_JWKS_URI` override is deleted from `api` and `mcp`, so
both derive the JWKS URI from the issuer instead.

```
today   http://app-keycloak:8080/realms/hill90/protocol/openid-connect/certs
after   https://app-auth.hill90.com/realms/hill90/protocol/openid-connect/certs
```

`api` falls back via `getJwksUri()` in `middleware/keycloak-config.ts:35`; `mcp`
via the default in `app/main.py:18`. Both compute `{issuer}/protocol/openid-connect/certs`.

**Verified reachable from inside both containers**, at 08:30 UTC:

```
app-api -> public JWKS   200, 2 keys
app-mcp -> public JWKS   200, 2 keys
app-api -> internal JWKS 200          (the path it uses today, still working)
```

**So it works. The point is what it now depends on.** Token validation leaves the
Docker network and goes out through Traefik and TLS. Three consequences worth
holding before you deploy rather than after:

- **If Traefik is down, authentication fails** — in a way it previously would
  not have, because the internal path did not touch the edge.
- **If the `app-auth.hill90.com` certificate lapses, authentication fails.** It
  currently expires **27 Oct 2026**.
- **A DNS or edge misconfiguration becomes an auth outage**, not just a routing
  one.

The upside this buys is real: one issuer value, impossible to diverge from the
one Keycloak actually stamps into tokens. Divergence there is what produced the
`iss` mismatch class of bug. This is a deliberate trade, not an oversight.

**How you would see it go wrong:** login itself would still work — that is the
browser talking to Keycloak directly — but authenticated API calls would start
returning **401**. Check `docker logs app-api` for JWKS fetch failures, and
confirm with `curl -sI https://app-auth.hill90.com/realms/hill90`. The signature
is "I can sign in but everything says unauthorised".

## 4. `#25` — Keycloak pinning. Confirmed a true no-op.

`app-keycloak`'s `KC_HOSTNAME` and Traefik router rule were pinned to the literal
`app-auth` rather than being derived from `APP_AUTH_HOST`.

**The rendered configuration is identical to what is running** — no environment
variable differs, no label differs, the command and healthcheck are unchanged. It
is a no-op today by construction: the previous default resolved to the same
string.

The consequence is that `docker compose up -d` will see nothing to change, so
**`app-keycloak` is not recreated and not restarted**. Deploying `auth` is free.

Its value is future-proofing: retargeting the app by changing `APP_AUTH_HOST` can
no longer move the tenant's own Keycloak onto `auth.hill90.com`.

## 5. What could plausibly break, and how you would see it

| Risk | Likelihood | Signature |
|---|---|---|
| JWKS unreachable through the edge | low — verified 200 from both containers | login works, API calls 401 |
| `api` or `ui` image fails to build | low — CI passes on `main` | deploy stops at the build step; old container keeps running |
| `app-ui` restart drops sessions | expected | users re-authenticate; not an error |
| `app-keycloak` disruption | none | it is not recreated |

**Deploy order does not matter here.** `api` creates `agent_sandbox` and
`docker_proxy`, but both already exist, and nothing in this set changes network
declarations.

## 6. If you want the smallest possible step

Deploying `auth` alone is genuinely free — a confirmed no-op that will not even
recreate the container. It exercises the pipeline end to end without changing
anything, which is a reasonable way to confirm the deploy path works after
pulling the checkout (brief §3) before committing to the stacks that do change.

---

*Measured 2026-07-29 08:30 UTC against `hill90-app` `fb90223` and the containers
running at that time. Re-render before acting if more has merged since.*
