# Detecting a scheduled workflow that stops triggering entirely

**Status: BUILT, not yet deployed.** Design and reasoning below; the mechanism
described is what the code in this PR does, not a future state — but it has
not yet run in production and its live-verification section says exactly what
was and was not proven before merge.

`Established 2026-08-05, h#712 (narrowed).`

---

## The distinction this exists to close

`docs/decisions/dead-mans-switch.md` and the `workflow_run`-triggered watchdog
(h#712/#714/#715/#716) together answer: **did a tracked scheduled workflow run,
and did it succeed?** That watcher fires on GitHub's own `completed` event,
reaches Alertmanager's proven email path, and covers all four scheduled
workflows in this repo. h#711 — the vault sync token dead for 18 of the last
20 weekly runs, unnoticed for five months — was exactly this shape: the
workflow ran, on schedule, and failed. Going forward, that shape is emailed
the same day it happens, not found five months later by someone going
looking.

**What neither of those can see: a workflow that stops *triggering* at all.**
GitHub auto-disables a schedule after 60 days of repository inactivity, or a
`cron:` line gets deleted or edited. No run means no `completed` event, so the
event-triggered watcher stays silent right alongside the thing it watches —
total absence, not a bad result from something that happened. This is a
structurally different failure with a different signature, and it needs a
different mechanism: something that alerts on the *absence* of a signal, the
same shape as `docs/decisions/backup-failure-signal.md`'s dead-man's-switch
for nightly backups, reused here rather than reinvented.

## The signal: a per-workflow textfile, node-exporter serves it, same as backups

**The textfile collector is already proven live** for this exact shape —
`hill90_backup_last_success_timestamp_seconds`, staleness rule, absence rule,
all confirmed working against a real 30-hour-old file and a real deleted file
(`backup-failure-signal.md`). Nothing new was built to reuse it: no new
container, no new listener, no new network exposure. One more SSH command in
each of the four scheduled workflows, one new Prometheus rule group.

**One file per workflow, not a shared file.** Four independently-scheduled
jobs (30 minutes, 4 hours, daily, weekly) writing into the same file would be
a real read-modify-write race the moment two land close together — sidestepped
entirely by giving each workflow its own file. node-exporter's textfile
collector already unions every `.prom` file in the directory into one metric
namespace, so this costs nothing beyond naming each file distinctly.

```
# HELP hill90_scheduled_workflow_last_run_timestamp_seconds Unix time this scheduled workflow last reached a verdict (success or failure), regardless of what it decided
# TYPE hill90_scheduled_workflow_last_run_timestamp_seconds gauge
hill90_scheduled_workflow_last_run_timestamp_seconds{workflow="vault-sync-to-sops"} 1793073600
```

Written to `/opt/hill90/metrics/textfile_collector/hill90_scheduled_workflow_<name>.prom`,
atomically (`.tmp` then `mv -f`), same discipline as `backup.sh`'s own emitter
— a half-written file flips `node_textfile_scrape_error` to 1, a real
alertable condition this must not manufacture.

## Why `if: always()`, not `if: success()` — the one design decision that isn't obvious

The backup dead-man's-switch keys its heartbeat on the job's own success,
because a stale *success* is exactly what should page someone — there is no
separate mechanism already covering "the backup ran and failed". These four
workflows are different: the `workflow_run` watchdog **already** pages on a
bad result, immediately, every time.

If the heartbeat here were ALSO keyed on the check's own verdict, a workflow
that runs correctly and finds a real problem — `deploy-drift` finding
actionable drift, `audit-hill90-ui-client` finding a real secret mismatch —
would go stale on *this* metric too, and generate a second, redundant alert
hours later for the same event the watchdog already emailed same-day. That is
not new coverage, it is noise layered onto an alert that already fired, and
this file's own header comment on `alerts.yml` already makes the argument for
why repeated noise trains someone to ignore the sender.

The heartbeat instead answers **"did the scheduler dispatch this and did it
reach a decision point at all"** — `if: always()`, the final step of the job,
unconditional on whatever the check itself concluded. Orthogonal to the
`workflow_run` watchdog by construction: a workflow that fires and fails still
writes its heartbeat (and still gets emailed immediately by the other
mechanism); a workflow that never fires writes nothing and only staleness
ever notices.

**Corollary that follows directly, stated because it is exactly the line
`backup-failure-signal.md` names as the one most likely to be got wrong:** if
connectivity to the VPS is itself broken (Tailscale down, SSH failing), the
heartbeat step ALSO cannot succeed — so a genuinely broken connectivity path
does not silently keep refreshing a fake heartbeat. It fails the same way the
rest of the job does, and eventually goes stale too, which is accepted
overlap with the `workflow_run` watchdog's own coverage of that failure, not
a gap.

## The one asymmetry checked before building, not assumed uniform

Three of the four workflows (`deploy-drift.yml`, `audit-hill90-ui-client.yml`,
`vault-sync-to-sops.yml`) already open an authenticated SSH+Tailscale session
to the VPS for their own checks — the heartbeat step there is one more
command reusing plumbing that already exists.

`tenant-baseline-agreement.yml` had **none** — it is a pure GitHub-side
comparison between this repo and a sparse checkout of `hill90-app`, and never
touched the VPS before this. Instrumenting it meant adding the whole
Tailscale/SSH-key/SOPS-for-the-IP sequence from scratch, copied verbatim from
`vault-sync-to-sops.yml` rather than invented fresh — a materially larger,
not equal, cost compared to the other three, and it was sized correctly
before being paid rather than assumed the same across all four.

## `deploy-drift.yml`'s positive-control path is deliberately excluded

`deployed_sha_override` lets someone dispatch the drift check against a
synthetic stale SHA to prove the alarm can fire, without touching the VPS at
all (see the workflow's own header). The heartbeat step is gated
`if: always() && inputs.deployed_sha_override == ''` for two reasons: that
path never resolves a Tailscale IP, so the step would just fail to connect —
but more importantly, a synthetic test dispatch succeeding is not evidence
the real schedule fired, and letting it refresh the heartbeat would let
someone keep this metric artificially fresh by re-running the control while
the actual cron silently stopped — precisely the failure this alert exists to
catch.

## The threshold, per workflow — one number per cadence, not one number for all four

Same reasoning `backup-failure-signal.md` used to derive 26h/50h from a
specific 24h cadence: each workflow's own nominal gap, plus real slack against
GitHub's own documented scheduling imprecision (`dead-mans-switch.md`
measured 62–116 minutes of lateness on a *weekly* cron), not a guess and not
one shared number.

| Workflow | Cadence | Threshold | Reasoning |
|---|---|---|---|
| `audit-hill90-ui-client` | every 30 min | 3h | ~6 missed runs — generous given the tightest cadence here and GitHub's own admitted lateness |
| `deploy-drift` | every 4h | 12h | ~3 missed runs, 8h slack past nominal |
| `tenant-baseline-agreement` | daily, 06:30 UTC | 30h | one missed day + 6h slack, same shape as backup's 24h→26h |
| `vault-sync-to-sops` | weekly, Mon 06:00 UTC | 192h (8 days) | one missed week + 1 day slack — generous relative to this exact workflow's own measured ~1–2h of scheduler lateness |

Each staleness rule uses `for: 15m`, matching `BackupNotSucceeding`. Each has
a matching absence rule (`ScheduledWorkflowSignalMissing`), `for: 6h`,
mirroring `BackupSignalMissing` exactly — cadence-independent, since "the
metric never showed up at all" is a structural condition, not a timing one.

## Who watches this

Nobody new. This rides entirely on Prometheus + node-exporter's textfile
collector + Alertmanager — the same infrastructure carrying every other alert
in this file already. `docs/decisions/dead-mans-switch.md` already asked "who
watches Prometheus itself", found every internal candidate shares a failure
domain with what it watches, and left the honest gap open as Jon's call on an
external paid service. This group does not attempt to close that gap, and
should not be read as having done so. `h#714`'s own header comment already
rejected building a second scheduled workflow to watch the first one — "one
layer that reaches a human beats two that watch each other" — and that
reasoning applies identically here: no second watcher was built for this
group either.

## Live verification — what this section proves, and what it does not

<!-- Filled in after live verification, before merge. -->

## What this does not cover

- **Inbox arrival.** Handoff to SMTP is what Alertmanager's counters can
  prove; whether an email actually lands in an inbox is a ten-second check
  that is deliberately Jon's to make, the same boundary
  `backup-failure-signal.md` and h#712's own comment thread already drew.
- **Prometheus or Alertmanager itself going silent.** Covered by nothing
  here, on purpose — see "Who watches this" above.
- **A workflow whose schedule is fine but whose logic silently no-ops.** The
  heartbeat proves the workflow *ran and reached a decision*, not that the
  decision itself was checking anything real. That is a different class of
  defect (a check that is `health=ok` but structurally cannot fire —
  `check_alert_series.py`'s whole reason for existing) and this mechanism
  does not detect it.
