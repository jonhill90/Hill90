---
name: tmux
description: Run interactive CLIs in persistent tmux sessions by sending keystrokes and reading pane output. Use when Claude Code, Codex, GitHub Copilot CLI, or any TUI/REPL must keep state across commands.
argument-hint: <goal or command>
---

# tmux

Use tmux when a task needs a persistent terminal state across tool calls.

## Prerequisites

```bash
tmux -V
```

If tmux is not installed, stop and ask the user to install it.

## Why tmux for Agents

tmux sessions survive SSH drops, terminal closes, and laptop sleep. This makes them ideal for AI agent workflows:

- **Persistence** — a long-running build or test suite continues even if your terminal disconnects.
- **Detach/reattach** — reconnect to a session hours later and see full scrollback.
- **Isolation** — each agent gets its own session with independent state.
- **Observability** — attach from another terminal to watch an agent work in real time.

## Socket Convention

Use a dedicated socket directory:

```bash
SOCKET_DIR="${VIBES_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/vibes-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/vibes.sock"
```

Use short session names with no spaces. Target panes by window name (e.g. `session:shell`) rather than numeric index (e.g. `session:0.0`) — numeric indexes depend on `base-index`/`pane-base-index` settings and are not portable.

## Quickstart

```bash
SESSION="vibes-work"
tmux -S "$SOCKET" new-session -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":shell -l -- "echo ready"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell -S -200
```

After creating a session, show monitor commands:

```bash
tmux -S "$SOCKET" attach -t "$SESSION"
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell -S -200
```

## Sending Input Reliably

- Use literal sends for text payloads: `send-keys -l -- "$cmd"`.
- Send `Enter` separately with a short delay.
- Send control keys separately (for example `C-c`).

```bash
tmux -S "$SOCKET" send-keys -t "$SESSION":shell -l -- "$cmd"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell Enter
```

Do not combine text and Enter in one fast send for interactive agent TUIs.

## Live Supervision Workflow

Use this when a user wants to watch an agent run and intervene live.

```bash
# start session and launch agent
tmux -S "$SOCKET" new-session -d -s review-agent -n shell
tmux -S "$SOCKET" send-keys -t review-agent:shell -l -- "cd /path/to/repo && codex"
sleep 0.1
tmux -S "$SOCKET" send-keys -t review-agent:shell Enter

# watch live in another terminal
tmux -S "$SOCKET" attach -t review-agent

# from operator terminal: inspect and steer
tmux -S "$SOCKET" capture-pane -p -J -t review-agent:shell -S -200
tmux -S "$SOCKET" send-keys -t review-agent:shell -l -- "run tests and summarize failures"
sleep 0.1
tmux -S "$SOCKET" send-keys -t review-agent:shell Enter
tmux -S "$SOCKET" send-keys -t review-agent:shell C-c
```

Use explicit session names per task (for example `review-agent`, `fix-auth`, `release-check`) so operators can track runs quickly.

## Common Commands

```bash
# list sessions and panes
tmux -S "$SOCKET" list-sessions
tmux -S "$SOCKET" list-panes -a

# capture output
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell -S -400

# interrupt running command
tmux -S "$SOCKET" send-keys -t "$SESSION":shell C-c
```

## Agent CLI Patterns

Use one session per tool or repo for isolation.

```bash
# Claude Code
tmux -S "$SOCKET" new-session -d -s claude-main -n shell
tmux -S "$SOCKET" send-keys -t claude-main:shell -l -- "cd /path/to/repo && claude"
sleep 0.1
tmux -S "$SOCKET" send-keys -t claude-main:shell Enter

# Codex
tmux -S "$SOCKET" new-session -d -s codex-main -n shell
tmux -S "$SOCKET" send-keys -t codex-main:shell -l -- "cd /path/to/repo && codex"
sleep 0.1
tmux -S "$SOCKET" send-keys -t codex-main:shell Enter

# GitHub Copilot CLI (detect installed command)
COPILOT_CMD=""
for cmd in copilot ghcs; do
  command -v "$cmd" >/dev/null 2>&1 && COPILOT_CMD="$cmd" && break
done
if [[ -z "$COPILOT_CMD" ]] && gh copilot --help >/dev/null 2>&1; then
  COPILOT_CMD="gh copilot"
fi

if [[ -n "$COPILOT_CMD" ]]; then
  tmux -S "$SOCKET" new-session -d -s copilot-main -n shell
  tmux -S "$SOCKET" send-keys -t copilot-main:shell -l -- "cd /path/to/repo && $COPILOT_CMD"
  sleep 0.1
  tmux -S "$SOCKET" send-keys -t copilot-main:shell Enter
fi
```

When prompting these tools later, keep using the same session and split text/Enter.

## Git Worktrees for Agent Isolation

Use `git worktree` to give each agent its own working directory without cloning:

```bash
# create worktrees from the main repo
git worktree add ../repo-agent-a -b agent-a
git worktree add ../repo-agent-b -b agent-b

# one tmux session per worktree
tmux -S "$SOCKET" new-session -d -s agent-a -n shell
tmux -S "$SOCKET" send-keys -t agent-a:shell -l -- "cd ../repo-agent-a"
sleep 0.1
tmux -S "$SOCKET" send-keys -t agent-a:shell Enter

tmux -S "$SOCKET" new-session -d -s agent-b -n shell
tmux -S "$SOCKET" send-keys -t agent-b:shell -l -- "cd ../repo-agent-b"
sleep 0.1
tmux -S "$SOCKET" send-keys -t agent-b:shell Enter
```

Each agent works on an independent branch with no lock contention on the index.

## Multi-Agent Orchestration

Run multiple agents in parallel, each in its own session and worktree:

```bash
AGENTS=("frontend" "backend" "tests")
for agent in "${AGENTS[@]}"; do
  # create worktree if it doesn't exist
  [[ -d "../repo-$agent" ]] || git worktree add "../repo-$agent" -b "$agent"

  # create session
  tmux -S "$SOCKET" new-session -d -s "$agent" -n shell
  tmux -S "$SOCKET" send-keys -t "$agent":shell -l -- "cd ../repo-$agent"
  sleep 0.1
  tmux -S "$SOCKET" send-keys -t "$agent":shell Enter
done

# monitor all sessions
tmux -S "$SOCKET" list-sessions

# check output from a specific agent
tmux -S "$SOCKET" capture-pane -p -J -t frontend:shell -S -200
```

## Helpers

Use bundled scripts:

- `scripts/find-sessions.sh` to inspect sessions/sockets.
- `scripts/wait-for-text.sh` to wait for a prompt or ready marker.

Both scripts support `-S` (socket path) and `-L` (socket name) flags.

Examples:

```bash
{baseDir}/scripts/find-sessions.sh -S "$SOCKET"
{baseDir}/scripts/wait-for-text.sh -S "$SOCKET" -t "$SESSION":shell -p 'ready|Done|❯|\\$'
```

## Cleanup

```bash
tmux -S "$SOCKET" kill-session -t "$SESSION"
tmux -S "$SOCKET" kill-server
# clean up worktrees when done
git worktree remove ../repo-agent-a
```

## References

For tmux fundamentals beyond this workflow guide, see [references/fundamentals.md](references/fundamentals.md):
- Session/window/pane structure and targeting
- Window and pane management (splits, resize)
- Advanced capture-pane and scrollback configuration
- Environment variables and troubleshooting

## Notes

- tmux supports macOS/Linux natively. On Windows, use WSL.
- Prefer tmux for interactive tools, auth flows, and REPLs.
- Prefer normal exec/background jobs for non-interactive commands.
