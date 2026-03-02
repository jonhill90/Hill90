---
name: using-tmux
description: Use tmux correctly from an agent — explicit pane targeting, send verification, state distinction, and recovery. Use when Claude Code, Codex, GitHub Copilot CLI, or any TUI/REPL must keep state across commands.
argument-hint: <goal or command>
---

# using-tmux

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

## Pane Targeting

Always use explicit targets. Never rely on the "active" pane — it changes when you split, select, or switch windows.

### Target formats

| Format | Example | When to use |
|--------|---------|-------------|
| `session:window` | `work:shell` | Single-pane windows |
| `session:window.{selector}` | `work:shell.{top}` | Layout-relative (predictable splits) |
| `session:window.%ID` | `work:shell.%3` | Specific pane by ID (from `list-panes`) |

### Layout-relative selectors

After a vertical split (`split-window -v`), use `{top}` and `{bottom}`.
After a horizontal split (`split-window -h`), use `{left}` and `{right}`.
Use `{last}` for the previously active pane.

### Discover pane IDs

```bash
tmux -S "$SOCKET" list-panes -t "$SESSION":shell \
  -F '#{pane_id} #{pane_index} #{pane_width}x#{pane_height} #{pane_current_command}'
```

Use the `%`-ID (first column) when layout is unknown or complex.

### Verify your target before sending

Before sending input to a pane, confirm it contains what you expect:

```bash
# Capture and check — is this the pane I think it is?
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{bottom} -S -5
```

If the content doesn't match your expectation (wrong shell, wrong directory, unexpected output), you have the wrong target. Fix the target before sending.

## Sending Input Reliably

### Pre-send readiness check

Before sending to a pane, verify it is ready to receive input:

```bash
# Check the pane has a shell prompt (not a running command)
OUTPUT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -3)
echo "$OUTPUT"  # inspect: do you see a prompt?
```

### Send text and Enter separately

```bash
tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- "$cmd"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter
```

- Use `-l` (literal) for text payloads.
- Send `Enter` separately with a short delay.
- Send control keys separately (e.g. `C-c`, `C-d`).
- Do not combine text and Enter in one fast send for interactive agent TUIs.

## Send Verification

After sending input, verify it landed. Two distinct checks:

| Check | What it answers | How to do it |
|-------|----------------|--------------|
| **Send confirmation** | Did the text arrive in the target pane? | `capture-pane` + grep for the sent text |
| **Response readiness** | Has the command produced output or returned to prompt? | `wait-for-text.sh` with output/prompt pattern |

### Send confirmation

```bash
tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- "echo hello-canary"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter
sleep 0.3
OUTPUT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -10)
if echo "$OUTPUT" | grep -q "hello-canary"; then
  echo "SEND OK"
else
  echo "SEND FAILED — text not found in target pane"
fi
```

### Response readiness

```bash
.github/skills/using-tmux/scripts/wait-for-text.sh \
  -S "$SOCKET" -t "$TARGET" -p 'Done|ready|❯|\$' -T 30
```

> **Never skip send verification.** "I sent it" is not the same as "the pane received it." Silent failures (wrong target, pane not ready, socket mismatch) produce no error — only verification catches them.

## State Distinction

When working with tmux panes, distinguish these four states clearly:

| State | What happened | How to detect | Common mistake |
|-------|---------------|---------------|----------------|
| **Text visible in pane** | tmux rendered the text | `capture-pane` shows the text | Assuming visible = accepted |
| **Input accepted** | The process in the pane received the keystrokes | Process shows activity (spinner, "thinking...") | Assuming accepted = responded |
| **Delivered to intended pane** | The text landed in the pane you targeted | `capture-pane -t $TARGET` + grep confirms | Sending to active pane instead of explicit target |
| **Process responding** | The process is producing meaningful output | `wait-for-text.sh` detects output pattern | Treating silence as "still working" when the send was lost |

Always confirm at least states 3 and 4 for critical operations.

## Recovery

### Wrong-target recovery

If you sent input to the wrong pane:

1. **Detect**: `capture-pane -t $INTENDED_TARGET` — your text is absent.
2. **Find**: `capture-pane -t $WRONG_TARGET` — your text appeared here instead.
3. **Cancel**: Send `C-c` to the wrong pane if the command is running.
4. **Re-send**: Send the input to the correct target.

```bash
# Cancel the accidental command in the wrong pane
tmux -S "$SOCKET" send-keys -t "$WRONG_TARGET" C-c
# Re-send to the correct pane
tmux -S "$SOCKET" send-keys -t "$CORRECT_TARGET" -l -- "$cmd"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$CORRECT_TARGET" Enter
```

### Socket permission issues

```bash
# Check socket exists and permissions
ls -la "$SOCKET"

# Common fix: socket dir not writable
chmod 700 "$SOCKET_DIR"

# On shared systems, use VIBES_TMUX_SOCKET_DIR to isolate
export VIBES_TMUX_SOCKET_DIR="$HOME/.tmux-sockets"
mkdir -p "$VIBES_TMUX_SOCKET_DIR"
```

### Hung-process recovery

```bash
# Try interrupt first
tmux -S "$SOCKET" send-keys -t "$TARGET" C-c

# If still hung, kill the pane's process
PANE_PID=$(tmux -S "$SOCKET" display-message -t "$TARGET" -p '#{pane_pid}')
kill -9 "$PANE_PID"
```

## Long-Running TUIs

When a pane runs a TUI (agent CLI, REPL, editor):

- **Do not guess state** — always `capture-pane` before sending. The TUI may have advanced, errored, or prompted since you last looked.
- **Use `wait-for-text.sh`** with appropriate patterns and timeouts for TUI readiness markers.
- **Detect TUI exit** — check `pane_current_command` from `list-panes`. If it shows `bash`/`zsh` instead of the TUI process, the TUI has exited.

```bash
# Check what process is running in the pane
tmux -S "$SOCKET" list-panes -t "$SESSION":shell \
  -F '#{pane_id} #{pane_current_command}'
```

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

Use explicit session names per task (e.g. `review-agent`, `fix-auth`, `release-check`) so operators can track runs quickly.

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

## Worktree Integration

For filesystem isolation between agents, use the `using-git-worktrees` skill to create worktrees before starting tmux sessions. Do not duplicate worktree creation logic here.

Pattern: one worktree per agent, one tmux session (or pane) per worktree.

## Helpers

Use bundled scripts:

- `scripts/find-sessions.sh` to inspect sessions/sockets.
- `scripts/wait-for-text.sh` to wait for a prompt or ready marker.

Both scripts support `-S` (socket path) and `-L` (socket name) flags.

Examples:

```bash
.github/skills/using-tmux/scripts/find-sessions.sh -S "$SOCKET"
.github/skills/using-tmux/scripts/wait-for-text.sh -S "$SOCKET" -t "$SESSION":shell -p 'ready|Done|❯|\\$'
```

## Self-Test

To verify tmux mechanics work in your environment, run the self-test procedure in [references/self-test.md](references/self-test.md).

## Cleanup

```bash
tmux -S "$SOCKET" kill-session -t "$SESSION"
tmux -S "$SOCKET" kill-server
```

## References

- [references/fundamentals.md](references/fundamentals.md) — Session/window/pane structure, targeting, splits, resize, capture-pane, scrollback, environment variables, troubleshooting.
- [references/self-test.md](references/self-test.md) — Deterministic smoke test for verifying tmux mechanics.

## Notes

- tmux supports macOS/Linux natively. On Windows, use WSL.
- Prefer tmux for interactive tools, auth flows, and REPLs.
- Prefer normal exec/background jobs for non-interactive commands.
- For multi-agent lane orchestration (e.g. Claude+Codex split-pane with human mediation), see a dedicated supervisor lane skill.
