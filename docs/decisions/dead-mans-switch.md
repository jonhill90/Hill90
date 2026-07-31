# Who watches Prometheus?

**Status: designed, deliberately NOT built.** No mechanism in this estate is fit
to be the watcher, and the record of *why* is the deliverable.

`Established 2026-07-31, read-only against production.`

---

## The failure

If Prometheus stops scraping, or Alertmanager dies, or the rules stop being
loaded, every alert in this estate goes quiet at once. **Silence is what a
healthy night looks like.** There is no way to tell the two apart from the
outside, and the person who would notice is the person who stopped being told.

This is not hypothetical here. Until 2026-07-31 `prometheus.yml` had `rule_files`
and no `alerting` block, so six rules evaluated into nothing. `ServiceDown` fired
for **at least 48 hours** in the week to 2026-07-26 and reached nobody. Nothing
looked wrong, because nothing looking wrong is precisely the symptom.

## The standard answer, and its one real requirement

A **dead man's switch**: an alert whose condition is `vector(1)`, so it fires
permanently, routed to a receiver whose job is to notice when it *stops* arriving.
Heartbeat present, everything is evaluating and delivering. Heartbeat missing,
the monitoring itself is down.

The mechanism is trivial. The requirement is not:

> **The thing that notices the absence must not share a failure domain with the
> thing it watches.**

A watchdog inside the stack dies with the stack and reports nothing, which is
worse than no watchdog because the empty inbox now looks deliberate.

## What this estate actually has, measured

| Candidate | Outside the failure domain? | Verdict |
|---|---|---|
| Cron on the VPS | No — dies with the host, and with Docker | Rejected |
| A second Prometheus/Alertmanager on the VPS | No — same host, same Docker daemon | Rejected |
| Alertmanager alerting on its own absence | No — cannot report its own death | Rejected |
| Tailscale | Coordination is external, but it delivers no notifications | Not applicable |
| **GitHub Actions scheduled workflow** | **Yes — GitHub's infrastructure, already wired to the tailnet** | **Rejected on evidence, below** |
| External dead-man SaaS (healthchecks.io, Dead Man's Snitch) | Yes — purpose-built for exactly this | **The only fit; needs an account** |

### Why GitHub Actions was rejected, despite being the obvious answer

It is the only external mechanism this estate already owns, and
`vault-sync-to-sops.yml` has been exercising it weekly. That workflow is the
evidence, and it disqualifies the approach:

```
cron: '0 6 * * 1'   (nominal 06:00 UTC Monday)

2026-07-27  started 07:02:34Z   success
2026-07-20  started 07:01:50Z   FAILURE
2026-07-13  started 07:03:54Z   FAILURE
2026-07-06  started 07:29:40Z   FAILURE
2026-06-29  started 07:39:01Z   FAILURE
2026-06-22  started 07:56:36Z   FAILURE
2026-06-15  started 07:54:46Z   FAILURE
2026-06-08  started 07:38:38Z   FAILURE
2026-06-01  started 07:42:45Z   FAILURE
```

**Eight of the last nine scheduled runs failed**, across two months. Every run
started **62 to 116 minutes** after its nominal time — GitHub's scheduler is
best-effort and visibly so here. And the failing step is
**`Verify SSH connectivity`**: the runner cannot reach the VPS, which is exactly
the step a watchdog would depend on.

So the candidate is late, it is broken, and it has been broken for two months
without producing a response. **A watcher with those properties is the thing we
were told not to build.** Its own silence would need watching.

There is a second, structural objection even if the workflow were repaired:
GitHub disables scheduled workflows after 60 days of repository inactivity. A
watchdog that switches itself off during a quiet period fails exactly when
attention is lowest.

## The conclusion

**Nothing available here can hold this job, so nothing was built.**

The honest position is that this estate currently **cannot detect its own
monitoring failing**. That gap is real, it is recorded, and it is not closed by
shipping a watcher that dies with what it watches — which would convert a known
gap into a false assurance.

Closing it needs one thing that does not exist yet: **an account with an external
dead-man's-switch service**. That is a decision for Jon, not a change to this
repo, because it means a third party, an outbound secret, and a monthly
dependency.

## The design, ready for when that exists

Recorded so this is a short job rather than a rediscovery.

**1. The rule** — `platform/observability/prometheus/alerts.yml`:

```yaml
  - name: watchdog
    rules:
      - alert: Watchdog
        # Always firing, by construction. Its PRESENCE is the signal; its
        # absence is what the external receiver alerts on.
        expr: vector(1)
        labels:
          severity: none
        annotations:
          summary: "Monitoring heartbeat — this alert always fires"
          description: >-
            If this stops arriving at the external receiver, Prometheus or
            Alertmanager has stopped working. Nothing is wrong with the estate
            because this IS firing.
          action: "Nothing. This firing is the healthy state."
```

**2. The route** — Alertmanager config, and this half is not optional:

```yaml
route:
  routes:
    - matchers: [ 'alertname = "Watchdog"' ]
      receiver: dead-mans-switch
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 2m      # must be well under the provider's grace period
      continue: false          # MUST NOT fall through to the email receiver

receivers:
  - name: dead-mans-switch
    webhook_configs:
      - url: <snitch URL from SOPS>
        send_resolved: false
```

**3. Grace period** at the provider: roughly 10× `repeat_interval` — 15 to 20
minutes for a 2m repeat. Short enough to matter, long enough to survive one
deploy of the observability stack.

### Why shipping the rule alone would be a mistake

An always-firing alert with no matching route falls through to the default
receiver. The default receiver is the proven email one. **It would email Jon
every `repeat_interval`, forever, starting immediately** — and the fastest way to
make someone ignore this sender is to do that. The rule and its route land
together or not at all. That is the whole reason this is written down rather than
half-applied.

### What it would and would not prove

- **Would prove:** rules are being evaluated, Alertmanager is alive, and it can
  deliver through that integration.
- **Would NOT prove:** that the *email* receiver works — pane 1 proved that
  separately by delivery — nor that Prometheus is still scraping every target. A
  Prometheus that has lost all its scrape targets still evaluates `vector(1)`
  happily. `ServiceDown` and `up == 0` remain the cover for that, and they only
  work if the heartbeat says the pipeline is alive.

The two checks compose: the watchdog proves the alerting path is alive, and the
ordinary rules prove the estate is. Neither substitutes for the other.

## Adjacent finding, not chased here

`vault-sync-to-sops.yml` has failed on eight of its last nine scheduled runs
since 2026-06-01, at the `Verify SSH connectivity` step. It was examined only far
enough to disqualify GitHub Actions as a watchdog host; whether the vault-to-SOPS
sync being two months stale matters is a separate question, and it belongs to
whoever owns the vault fallback path.
