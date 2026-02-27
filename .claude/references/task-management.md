# Task Management Reference

**Use the `linear` CLI for task tracking instead of TodoWrite.**

## Why Linear Over TodoWrite

**Context Reset Problem**:
- Development workflow: PLAN -> DOC -> **Clear conversation** -> EXEC
- TodoWrite state is **wiped** when conversation clears
- Linear issues **persist** across context resets (like PRD.md persists)
- Tasks need to survive the planning -> execution boundary

**When Each Tool Applies:**
- **Linear** (persistent): Real work items, team-visible tasks, cross-session tracking
- **TodoWrite** (ephemeral): ONLY in plan mode for immediate decomposition (rare)

## Linear Workflow

### Create Issue for New Work
```bash
# At start of feature development
linear issue create \
  --title "Deploy new API endpoint" \
  --priority 3 \
  --state unstarted \
  --label "backend"
```

### Update Status as You Work
```bash
# Mark as in-progress (doing)
linear issue update AI-123 --state started

# Complete (done — after merge + post-merge verification)
linear issue update AI-123 --state completed
```

### Query Existing Tasks
```bash
# Find your current work
linear issue list --sort priority --state started

# Find pending work
linear issue list --sort priority --state unstarted
```

## Hill90 -> Linear State Mapping

| Hill90 workflow | Linear state (CLI) | Linear display | Notes |
|---|---|---|---|
| `todo` | `unstarted` | Unstarted | Default for new planned work |
| `doing` | `started` | In Progress | Set when active coding begins |
| `review` | `started` | In Progress | PR status indicates review; Linear stays `started` |
| `done` | `completed` | Done | Set after merge + post-merge verification |

> `review` is not a valid Linear CLI state. During review, the issue stays `started` — the PR itself signals review status.

## Integration with Development Workflow

1. Break work into granular features/tasks
2. Each task -> Linear issue in Hill90 project
3. Context reset between planning & execution -> Linear persists
4. Update Linear issue with learnings as work progresses

## PR Lifecycle Mapping (Hill90 Harness)

- `todo`: Planned work, not yet started
- `doing`: Implementation in progress
- `review`: PR opened, CI/review feedback in progress
- `done`: PR merged and post-merge checks complete

Use this mapping with the required PR loop in `AGENTS.md` and `.github/docs/contribution-workflow.md`.

## Examples

**VPS Rebuild Task**:
```bash
linear issue create \
  --title "VPS Rebuild: Optimize from 30min to 5min" \
  --priority 2 \
  --state started \
  --label "infrastructure"
```

**API Deployment Task**:
```bash
linear issue create \
  --title "Deploy Hill90 API to production" \
  --priority 3 \
  --state unstarted \
  --label "deployment"
```

## Key Principle

**If the user will ask "what happened?" later, use Linear.**
**If it's throwaway planning for immediate execution, use TodoWrite (rare).**
