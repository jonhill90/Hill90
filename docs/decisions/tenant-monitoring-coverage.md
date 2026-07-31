# Tenant monitoring — what the platform covers, and where the boundary is

`Verified 2026-07-31 10:50 UTC`, read-only against production.

All the alerting built today watches the **platform**: its containers, certificates,
backups and disk. This establishes what any of it says about the **tenant** —
`hill90.com` and the seven `app-*` containers that serve it — and separates the part
that is plainly the platform's job from the part that would widen the tenancy contract.

## The short answer

**Prometheus scrapes zero tenant containers.** Fourteen scrape targets, none of them
`app-*`. What covers the tenant is one thing only: the blackbox probe of
`https://hill90.com/`, which is an outside-in check of a public hostname.

So `app-ui` failing is caught. **`app-api` failing was not**, and that is the gap this
change closes.

## The tenant's public surface, and what watches it

Read from the running containers' Traefik labels.

| Hostname | Container | Watched? |
|---|---|---|
| `hill90.com`, `www.hill90.com` | `app-ui` | **Yes** — `blackbox-public`, `PublicSiteDown` |
| `api.hill90.com` | `app-api` | **Now yes** — `blackbox-tenant-api`, `TenantApiDown` (this change) |
| `litellm.hill90.com` | `app-litellm` | No — see below |
| `ai.hill90.com/mcp` | `app-mcp` | No — see below |
| *not routed* | `app-ai`, `app-knowledge`, `app-docker-proxy` | No — internal only, `traefik.enable=false` or unset |

### Why `PublicSiteDown` does not cover the API — measured, not assumed

The obvious assumption is that if the API dies the site breaks, so one probe covers both.
**It does not**, and the evidence is specific:

```
https://hill90.com/            -> 200
https://hill90.com/api/health  -> 200   {"status":"healthy","service":"ui"}
https://api.hill90.com/health  -> 200   {"status":"healthy","service":"api"}
```

`hill90.com/api/health` is the **UI's own** health route. It reports `service: "ui"` and
does not proxy to `app-api`. The homepage renders from `app-ui` alone. So `app-api` can be
completely dead while `hill90.com` keeps answering 200 and `PublicSiteDown` stays silent.

*Not tested destructively:* `app-api` was never stopped to confirm the site still serves
200 without it — that would be an outage on production to prove a point. The conclusion
rests on the two health endpoints reporting different services and the homepage rendering
independently, which is strong but is inference.

### Why `litellm` and `ai/mcp` were not probed

Both return non-200 in **normal, healthy** operation:

```
https://litellm.hill90.com/        -> 403      (edge IP allowlist, working as designed)
https://litellm.hill90.com/health  -> 403
https://ai.hill90.com/mcp          -> 404
```

A 200-expecting probe would alert permanently, which is worse than no alert. Probing them
properly means encoding the expected non-200 code, which is brittle, or reaching past the
allowlist, which is not an outside-in check. **Left uncovered deliberately**, and recorded
here rather than silently skipped.

## The tenancy boundary

[`app-tenancy-on-the-vps.md`](app-tenancy-on-the-vps.md) states the contract. Its table
has a row for this, and **the row's stated basis is false** — corrected in that file by
this change:

> | Observability of tenant containers | partial — `cadvisor` scrapes all containers; no app-specific Prometheus job | not a blocker |

cAdvisor does **not** scrape all containers on this host. It emits 45 cgroup and systemd
series and **zero Docker containers** — `count(container_memory_usage_bytes{name!=""})` is
0, and the only ids mentioning Docker are `docker.service`, `docker.socket` and
`containerd.service`, which are the daemons. The record claimed partial coverage that has
never existed; actual coverage of tenant containers is **nil**.

### What this change does — edge scope, not a widening

Probing `https://api.hill90.com/health` from outside is the **same class of check** as the
already-shipped probe of `hill90.com`:

- It targets a **public hostname this platform's Traefik routes** and holds the
  certificate for. "Does this hostname serve?" is an edge question, and the edge is the
  platform's.
- It uses **no credential** and reaches **no container**. It is HTTP from the outside.
- It adds **no scrape target inside the tenant** and reads none of its metrics.

The one piece of tenant knowledge it encodes is the path `/health`, because
`api.hill90.com/` returns 404. That is a real coupling: if the tenant moves that path, this
alert lies. It is small, and the alternative — probing a root that 404s — is not viable.

### What would be a widening, and is NOT being done

**Scraping the tenant's containers into the platform's Prometheus.** That would mean the
platform observing tenant internals, alerting on tenant container health, and implicitly
taking responsibility for them. The contract is deliberately narrow, and this would widen
it without a decision. **It is Jon's call, not this repository's.**

Two facts for that decision:

1. **It is not currently possible without tenant changes.** No `app-*` container exposes a
   Prometheus endpoint — checked on the internal network:
   `app-ui:3000/metrics` 404, `app-litellm:4000/metrics` 404, `app-knowledge:8002/metrics`
   401, and `app-api`, `app-ai`, `app-mcp` refuse the connection outright. Instrumenting
   them is **app-lane work** that must happen first regardless.
2. **The cheap alternative already covers the outcome that matters.** An outside-in probe
   answers "is this broken for users", which is the question worth waking someone for.
   Container-level scraping answers "which part broke", which is a debugging convenience
   once you are already awake.

**Recommendation: do not scrape tenant containers.** Add outside-in probes for public
hostnames as the platform's edge responsibility, and leave the tenant's internals to the
tenant. If deeper visibility is wanted later, the right shape is the tenant running its own
Prometheus, or exporting to this one by agreement — a decision, with the contract updated.

### If you disagree with `TenantApiDown`

It is one job in `prometheus.yml` and one rule in `alerts.yml`, both labelled. Deleting the
rule and keeping the job leaves the probe collecting data without paging anyone, which is a
reasonable middle position if the boundary reading is judged too generous.

## What is still not covered, after this change

- **The tenant's internal containers** — `app-ai`, `app-knowledge`, `app-docker-proxy`.
  Nothing observes them.

  > **Correction, 2026-07-31.** This entry called `app-docker-proxy`'s failure "a
  > security-relevant availability event". **That overstated it.** `app-api` holds no raw
  > Docker socket, so losing the proxy leaves it no path to the daemon at all: the absence
  > **fails closed** and is an operational event, not a security one. What is genuinely
  > security-relevant is the control's *configuration* — ACL drift, and the fact that the
  > proxy filters by API path and not by container ownership — none of which is an
  > availability event or catchable by a probe. Full reasoning, and why covering it
  > properly is Jon's decision rather than a lane's, in
  > [docker-proxy-monitoring.md](docker-proxy-monitoring.md).
- **`litellm` and `ai/mcp`**, for the reasons above.
- **Which tenant component failed.** Both probes say "broken from outside", not why.
- **Tenant container restart loops.** The same cAdvisor absence that breaks per-container
  memory alerting on the platform applies here.
