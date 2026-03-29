# Hill90 Workflow (Low-Noise)

Goal: ship faster with fewer merge conflicts and less coordination overhead.

## Rules

1. One active coding lane at a time.
2. All other lanes are planning/research only.
3. A lane may start coding only when:
   - Linear issue is `In Progress`
   - dedicated git worktree exists
   - branch exists in that worktree
   - file ownership scope is declared
4. Supervisor auto-enter is enabled only for:
   - active lane Codex pane
   - admin lane Codex pane
5. Auto-enter trigger must use explicit prefix: `UPPROMPT:`
6. Never run two coding lanes that modify the same ownership scope.
7. PRs merge one at a time.
8. After each merge, all lanes sync to latest `main` before new coding.
9. If a lane hits a gate (merge approval, deploy watch, API outage), report blocker immediately and stop adding new work.
10. Close each issue with one strict packet:
    - issue state
    - branch/worktree
    - PR link
    - required checks
    - deploy state
    - blockers

## Worktree Convention

- Path: `.worktrees/feat/<issue-or-scope>`
- Branch: `feat/<issue-or-scope>` (or `fix/...`, `refactor/...`, `docs/...`)
- Never code directly on root `main` worktree.

## Supervisor Convention

Use supervisor with one active lane at a time.

Example (`model-router` active):

```bash
tmux respawn-pane -k -t hill90:supervisor-loop.1 \
  'cd /Users/jon/source/repos/Personal/Hill90 && \
   LOG_FILE=/tmp/hill90-supervisor-loop.log \
   STATE_FILE=/tmp/hill90-supervisor-loop.state \
   INTERVAL_SECONDS=2 \
   HEARTBEAT_SECONDS=15 \
   SUPERVISE_WINDOWS=model-router,admin \
   ALLOWED_CMDS=codex-aarch64-a \
   MIN_INPUT_CHARS=12 \
   REQUIRED_PREFIX=UPPROMPT: \
   bash scripts/supervisor-tmux-loop.sh hill90'
```

Health check:

```bash
scripts/supervisor-tmux-status.sh
```
