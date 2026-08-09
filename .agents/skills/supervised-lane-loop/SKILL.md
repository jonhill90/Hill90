---
name: supervised-lane-loop
description: Run Hill90's long-lived architecture supervisor over tmux worker lanes with production health gates, a named defect seam, independent verification, and token-efficient state-change wakes. Use when supervising Hill90 agents for hours or days, recovering its Claude workflow in Codex, or deciding whether a lane's PR is ready.
---

# Hill90 supervised lane loop

Read [the canonical lane contract](../../../.claude/skills/supervised-lane-loop/SKILL.md)
completely before supervising or reviewing a lane. It defines the health gate,
defect seam, positive-control standard, lane mechanics, and merge evidence.

Apply these Codex-specific adaptations:

- Treat the shell supervisor as a sensor, not an agent. It may poll every five
  minutes, but it wakes the architecture model only when a persisted fingerprint
  of tmux, git, GitHub issue/PR, or CI state changes.
- Never send a periodic prompt merely because the architecture pane looks idle.
  Usage-limit, approval, active, idle, and unknown states are distinct; only a
  changed state plus a verified idle prompt is eligible for one wake.
- Deduplicate every wake and enforce a cooldown. One external transition earns
  at most one model turn.
- Keep the wake prompt short. Put settled findings, current lane ownership, the
  health command, the active defect seam, and authorization boundaries in the
  verified handoff file.
- Start a fresh architecture session from the handoff when recovering a dead
  pane. Do not replay a multi-hour transcript.
- Use Terra medium for bounded implementation and review, Luna for mechanical
  high-volume work when available, and Sol for architecture, production risk,
  or final synthesis. Do not fork the full architecture history into workers.
- An idle worker lane is useful capacity only when a bounded, non-overlapping
  issue exists. Do not fan out merely to keep every lane occupied.
- The canonical contract describes merges, issue closure, and production checks,
  but never grants authority for them. The current user instruction and handoff
  boundaries govern every outward-facing or production action.

The local supervisor implementation and regression test live outside the repo:

- `/Users/jon/.local/bin/hill90-codex-supervisor`
- `/Users/jon/.local/state/hill90-codex-supervisor/test-supervisor.sh`
- `/Users/jon/.local/state/hill90-codex-supervisor/handoff.md`
