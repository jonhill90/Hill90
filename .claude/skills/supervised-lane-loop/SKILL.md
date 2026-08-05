---
name: supervised-lane-loop
description: Run a long-lived supervisor loop over one or more worker agent lanes — recurring health gate, a named defect family as the work seam, and verification standards that let work merge without the human reading diffs. Use when supervising agents across many hours or days, when a recurring cron prompt drives an agent, or when deciding whether a lane's PR is safe to merge.
---

# Supervised lane loop

A supervisor agent runs on a recurring prompt. Each firing it checks
production, reviews what the worker lanes produced, merges what it verified,
and gives idle lanes new work. The lanes implement; the supervisor never
implements and never trusts.

This works for days without human input because the *prompt* carries the
contract, the *seam* generates the next task, and the *standards* make merging
safe. Remove any of the three and the loop degrades within an hour — usually
into documentation passes, which feel productive and are not.

## The recurring prompt must be self-sufficient

Restate the whole contract every firing: the health command, the lane
protocol, the current seam, the standing rules, and the do-not-relearn list.

Do not rely on conversation history. Context gets summarised, sessions get
resumed cold, and standards that live 200 messages back decay silently. A
prompt that re-establishes everything costs a few hundred tokens per firing
and makes every firing independent.

Keep a **do-not-relearn list** in the prompt: conclusions already settled,
traps already paid for, and instrument quirks specific to this estate. Its
job is to stop the loop re-deriving the same answers, which is the main way
these loops waste days.

## Health first, and it is a hard gate

Begin every firing with the same concrete check, by name, against the real
system. Not a count — a list. Counts agree with themselves; a name that is
absent is a name.

Degraded means stop everything and report. Do not start new work on a
degraded estate, and do not let a lane's PR merge into one.

Two rules that come from getting this wrong:

- **Suspect the instrument before believing the verdict.** A failed local
  command reads exactly like an outage. Retry once, and check from a second
  vantage point, before reporting anything as down.
- **A "clean" result from a query that could not see the thing is not clean.**
  An empty result proves nothing unless you can show the query was capable of
  returning a non-empty one.

## The seam: name a defect family, not a task list

The single highest-leverage choice. A good seam is one sentence describing a
*class* of defect, and it generates its own next task.

The one that carried this repo for days: **"an operation that fails but
reports success."** From that one sentence, in order, without the human
supplying any of it:

read path in the UI → write path in the UI → non-atomic writes in the api →
success-reporting in shell scripts → unverified revokes in the secrets tooling

Each area exhausts, and the family points at the next one. Compare "find
bugs", which produces scattered, unrankable churn nobody can review.

Signs your seam has gone stale: findings get cosmetic, ranking gets
arbitrary, or the lanes start proposing documentation. Name a new family.

## Standards that make merging safe

The supervisor merges without the human reading diffs. That is only
defensible with all of these enforced.

**Positive-control everything, and show it failing first.** A test that has
never failed has not been shown to test anything. For a new check, prove both
directions: it goes red on a real violation and green without one. Prove it
against something real — a live container, a mutated production-shaped file —
not a fixture written to match the checker's own expectations, which only
proves the checker agrees with itself.

**A hit is not a finding.** Grep matches are candidates. For each, establish
what the caller/user/operator actually observes, and drop the ones where the
existing behaviour is correct. Report triaged-versus-real as a ratio. A sweep
that reports 66 findings from 66 matches did not triage.

**Closing something out as not-real is a result.** It is harder than fixing
it and more valuable. A defensive change to code that was already correct
looks like progress and leaves behind an error path that cannot occur.

**Verify against code or the host, never the PR body.** The body is the
author's belief. Read the diff, read the file, run the command. This catches
the specific class of error where the fix is right and the description is
wrong — and the reverse.

**Never re-run a test to make it green, and never quarantine one.** Read the
failure. If the suite is flaky enough that rerunning is reflex, that flake is
now the highest-leverage bug in the repo, because it is eroding this rule.

**Distinguish "the guard was off" from "something got through."** Every time
a missing check is found, these are two separate facts and the second must be
measured, not inferred from the first. Usually the answer is reassuring and
the report is stronger for having proven it.

**File an issue for anything parked.** A finding recorded only in a merged PR
body is parked where nobody will look for it again.

## Reviewing a lane's work

Read the review *and* verify it. Confident, well-written, wrong is the normal
failure mode — for lanes, for external review bots, and for the supervisor.

Things worth checking every time:

- Arithmetic and counts. Re-count them yourself. A PR correcting a document
  *because* it carried a bad number is exactly where a fresh bad number ships.
- Whether the fix leaves the same defect one layer down.
- Whether a shared helper's new behaviour breaks a caller that did not change.
- Whether the change quietly narrows or widens a security boundary.

Send findings back rather than fixing them yourself, and tell the lane to
check your reasoning rather than take it. You will be wrong sometimes; a lane
that defers to you propagates it.

**Praise restraint explicitly.** When a lane declines to overturn an existing
reasoned decision for lack of new evidence, or reports a hypothesis *you*
supplied as not-real, say so. Those are the behaviours that decay first under
pressure to produce.

## Lane mechanics

- Dispatch to an idle lane immediately. An idle lane is the only real waste.
- Send prompts as: clear the input line, type, **capture to confirm it
  landed**, then submit. Sends fail silently.
- Detecting idle is harder than it looks. A lane waiting on sub-agents or a
  background command is *working* while showing no activity indicator, and
  stale scrollback can make a finished lane look busy. Check the live tail,
  not a keyword anywhere in the buffer.
- Give each lane a distinct surface so two lanes never edit the same files.
  Parallelising a producer and its consumer ships a broken contract.
- Long tasks: state the goal, the ranking rule, the standard of evidence, and
  the boundary you will not authorise crossing. Then let them work.

## Reporting to the human

One or two lines when nothing needs them. The value of a quiet report is that
a loud one means something.

Escalate only what genuinely needs a decision: an irreversible action, an
outward-facing change, a security finding with real blast radius, or a fork
where either branch is defensible. State the options and give a
recommendation.

Report outcomes faithfully. Failures with their output, skipped steps named
as skipped, and boundaries stated — "this proves the message reached the mail
server, not an inbox" is worth more than a clean claim.
