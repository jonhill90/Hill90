# `app-docker-proxy` — what its absence actually means, and what covering it would cost

`Verified 2026-07-31 11:05 UTC`, read-only against production.

[`tenant-monitoring-coverage.md`](tenant-monitoring-coverage.md) called `app-docker-proxy`
*"a security-relevant availability event"* that is invisible. **Half of that was wrong, and
the half that is right is a different problem than the sentence implied.** This is the
reasoning, because the distinction changes what the fix should be.

## What it is

A `tecnativa/docker-socket-proxy` in front of the host's Docker socket. It is the **only**
tenant container holding `/var/run/docker.sock` (read-only), and it sits alone on the
tenant-owned `hill90_docker_proxy` network with exactly one consumer: **`app-api`**.

Its whitelist, read from the running container:

```
CONTAINERS=1   EXEC=1   NETWORKS=1   VOLUMES=1   POST=1   PING=1
ALLOW_START=0  ALLOW_STOP=0  ALLOW_RESTARTS=0
IMAGES=0  INFO=0  VERSION=0  SYSTEM=0  SWARM=0  SECRETS=0  CONFIGS=0  … (all others 0)
```

The whitelist is genuinely enforced — probed read-only through the proxy:

| Path | Result |
|---|---|
| `/_ping` | **200** |
| `/containers/json` | **200** |
| `/version` | **403** |
| `/info` | **403** |
| `/images/json` | **403** |

## Its absence fails CLOSED. That correction matters.

**`app-api` has no raw Docker socket.** Verified: the only containers mounting
`/var/run/docker.sock` are `promtail`, `traefik`, `portainer` (all platform) and the proxy
itself. `app-api` is not among them.

So if `app-docker-proxy` stops, `app-api` has **no other path to the Docker daemon**. Its
calls fail at the connection. The agent-sandbox capability stops working; **nothing is
bypassed, no control is skipped, and nothing is granted that was not granted before.**

That is **fail closed**, and it makes the proxy's absence an **operational** event, not a
security one. The previous description overstated it. A user-visible feature breaks — which
is worth noticing — but it does not belong in the same category as a control failing open.

## What IS security-relevant is the control's configuration, and that is genuinely invisible

The proxy is a **control**, and the failure mode of a control is not that it disappears —
it is that **it stops being enforced while everything still appears to work**. That case
has no availability signal at all:

- **ACL drift.** Flip `IMAGES=0→1`, `SYSTEM=0→1`, or `ALLOW_START=0→1` in the tenant's
  compose file and redeploy. The container is healthy, `/_ping` still answers 200, every
  probe stays green, and the tenant's reach into the host's Docker daemon has widened.
  **No metric moves.** Nothing in either repository asserts what that whitelist should be.
- **A consumer given the socket directly.** If a future tenant service mounts
  `/var/run/docker.sock` instead of going through the proxy, the proxy still runs, still
  answers, and is simply bypassed. Again, no availability signal.

### One present property, worth stating plainly

**The proxy is not scoped to the tenant's own containers.** Asked through the proxy,
`/containers/json` returns **24 containers — 7 tenant and 17 platform**, including
`postgres`, `openbao`, `keycloak`, `traefik` and `prometheus`. Combined with `EXEC=1` and
`POST=1`, the endpoints required to create and start an exec session in **any** container
on the host are permitted.

This is a property of `docker-socket-proxy` — it filters by API *path*, never by container
ownership — not a misconfiguration of it, and not something introduced today. It is
recorded because "the tenant's API is confined to the tenant's containers" is a reasonable
assumption to hold and **it is not true here**.

**Stated as configuration, not as a demonstrated exploit.** No exec was attempted against a
platform container: that would be an intrusion into production to prove a point already
legible from the ACL and the container listing. What was verified is that the listing is
unscoped and the exec endpoints are permitted.

**This is the tenant's security posture to decide, not the platform's to change
unilaterally** — but the platform is the party that carries the consequence, so it belongs
on the record.

## Covering it: start from what exists

cAdvisor emits **zero Docker container series** on this host, so the per-container route is
closed — that dead end has been walked twice today and is not worth a third attempt.

What does exist:

| Signal | Exists today? | Covers |
|---|---|---|
| `/_ping` on the proxy → **200** | **yes**, verified | availability (fail-closed case) |
| Prometheus scrape of `app-docker-proxy` | no — it exposes no `/metrics` | — |
| cAdvisor container series | **no** — zero on this host | — |
| Any assertion of the ACL values | **no**, in either repository | the case that actually matters |

So the availability half is cheap: a blackbox probe of `http://app-docker-proxy:2375/_ping`
expecting 200. The exporter and the alert pattern already exist; nothing new is needed
except the target.

**Except for one thing, and it is the deciding one.**

## This crosses the boundary that #624 just corrected

`hill90_docker_proxy` is a **tenant-owned network**, created by the app's
`docker-compose.api.yml`. The platform's `blackbox-exporter` is not on it — confirmed. To
probe the proxy, the platform's observability stack would have to **attach to a network the
tenant owns, in order to watch a tenant container's internal endpoint.**

That is precisely the widening #624 declined. It is not the same class as probing
`hill90.com` or `api.hill90.com`: those are **public hostnames this platform's Traefik
routes and holds certificates for**, checked from outside with no credential. This one is an
internal endpoint on a private tenant network, reachable only by joining it.

**So this is Jon's decision, not a lane's.** Three shapes, honestly costed:

1. **Do nothing.** The failure is fail-closed and user-visible: agent features stop working
   and someone notices through use. Defensible for a homelab, and it is the status quo.
2. **Platform probes the proxy.** Cheapest fix, ~5 lines. Requires attaching platform
   observability to a tenant network, which widens the contract and sets the precedent that
   the platform watches tenant internals. If that precedent is acceptable, say so *in the
   contract*, because the next request will cite it.
3. **The tenant covers itself.** The stronger answer, and it needs no boundary change: the
   tenant's own repository asserts its proxy's ACL in CI — a test that the whitelist equals
   the intended set — and, if it wants availability alerting, runs its own probe. **This is
   the only option that addresses the drift case**, which is the part that is actually
   security-relevant, and options 1 and 2 both leave it untouched.

**Recommendation: 3, then 1.** The ACL assertion is the valuable half and belongs in
`hill90-app` where the compose file lives. The availability half is genuinely minor, and
buying it by widening the tenancy contract is a poor trade for an event that already
announces itself.

## What was corrected here

[`tenant-monitoring-coverage.md`](tenant-monitoring-coverage.md) described this as a
"security-relevant availability event". Its *availability* is operational, because the
absence fails closed. Its *security* relevance lives in configuration drift and unscoped
reach, neither of which is an availability event and neither of which a probe would catch.
Conflating the two would have bought the cheap monitoring and left the real gap open.
