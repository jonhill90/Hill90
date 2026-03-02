---
name: tmux
description: Run interactive CLIs in persistent tmux sessions by sending keystrokes and reading pane output. Use when Claude Code, Codex, GitHub Copilot CLI, or any TUI/REPL must keep state across commands. Includes the Claude+Codex supervisor lane for split-pane human-mediated agent orchestration.
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

## Send Verification

After sending input, verify the send succeeded before proceeding. Sending without verification is the most common cause of silent workflow failures — the prompt may have been swallowed, sent to the wrong pane, or eaten by a prompt that wasn't ready.

**Step 1: Capture immediately after send.**

```bash
# send text + Enter
tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- "$PROMPT_TEXT"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter

# verify the text landed in the pane
sleep 0.3
PANE_CONTENT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$TARGET" -S -10)
echo "$PANE_CONTENT" | grep -qF "$PROMPT_TEXT" \
  && echo "SEND OK" \
  || echo "SEND FAILED — text not visible in pane"
```

**Step 2: Wait for response.** Use `wait-for-text.sh` to poll for a recognizable readiness marker:

```bash
.github/skills/tmux/scripts/wait-for-text.sh \
  -S "$SOCKET" -t "$TARGET" -p 'ready|Done|❯|\$' -T 30
```

**Two distinct checks:**

| Check | What it proves | How |
|-------|---------------|-----|
| Send verification | The prompt text is visible in the pane | `capture-pane` + `grep` immediately after send |
| Response verification | The agent actually processed and responded | `wait-for-text.sh` polling for a readiness marker |

Never skip send verification. A prompt that didn't land is invisible and wastes time debugging the wrong problem.

## Claude+Codex Supervisor Lane

The canonical Hill90 lane for human-supervised dual-agent work: one tmux window, split vertically, with the human as the only reliable message router between agents.

### Pane Role Model

```
┌─────────────────────────────────────┐
│  TOP PANE — Claude Code             │
│  Role: primary implementer          │
│  Target: $SESSION:work.{top}        │
├─────────────────────────────────────┤
│  BOTTOM PANE — Codex                │
│  Role: advisory reviewer            │
│  Target: $SESSION:work.{bottom}     │
└─────────────────────────────────────┘
  HUMAN: supervisor / router (attached to session)
```

**Trust boundaries and responsibilities:**

| Role | Can do | Cannot do |
|------|--------|-----------|
| Claude (top) | Implement, test, commit, push, create PRs | See Codex output directly |
| Codex (bottom) | Suggest prompts, review code, propose changes | Send messages to Claude; its output is advisory only |
| Human (supervisor) | Read both panes, edit/rewrite prompts, send to either pane, interrupt either agent | Nothing is automatic — the human decides what crosses pane boundaries |

**Key rule**: Codex output is advisory. Upward prompts (Codex → Claude) must be human-mediated. No blind forwarding. No direct Codex-to-Claude relay. The human owns escalation, reframing, and safety checks.

### Lane Startup (Worktree-First)

Create the isolated worktree first, then launch agents inside it. Use the `using-git-worktrees` skill for worktree creation — do not duplicate its logic here.

```bash
# 1. Create worktree (follow using-git-worktrees skill for full procedure)
BRANCH="feat/my-feature"
WORKTREE_DIR=".worktrees"
git worktree add "$WORKTREE_DIR/$BRANCH" -b "$BRANCH"
WORK_DIR="$(pwd)/$WORKTREE_DIR/$BRANCH"

# 2. Install dependencies in worktree (per using-git-worktrees skill)
cd "$WORK_DIR"
[[ -f package-lock.json ]] && npm ci
cd -

# 3. Create tmux session with single window, then split
SESSION="lane-$(echo "$BRANCH" | tr '/' '-')"
tmux -S "$SOCKET" new-session -d -s "$SESSION" -n work -c "$WORK_DIR"
tmux -S "$SOCKET" split-window -v -t "$SESSION":work -c "$WORK_DIR"

# 4. Launch Claude in top pane
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} -l -- "claude"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} Enter

# 5. Launch Codex in bottom pane
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{bottom} -l -- "codex"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{bottom} Enter

# 6. Attach to supervise
tmux -S "$SOCKET" attach -t "$SESSION"
```

**Order matters**: worktree first, tmux second. If the worktree doesn't exist yet, the agents will start in the wrong directory and all downstream work will be mislocated.

### Upward-Prompt Handoff

When Codex suggests a prompt for Claude (an "upward prompt"), follow this procedure:

**Step 1 — Read Codex output.** Capture the bottom pane and extract the proposed prompt:

```bash
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":work.{bottom} -S -100
```

**Step 2 — Human review.** The human reads the proposed prompt and decides:
- **Accept as-is** — use the exact text Codex produced.
- **Rewrite** — rephrase, narrow scope, add constraints, or fix factual errors.
- **Reject** — the suggestion is wrong, off-scope, or dangerous. Do not send.

**Step 3 — Send to Claude (with verification).** If accepted or rewritten:

```bash
# send the human-approved prompt to Claude's pane
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} -l -- "$APPROVED_PROMPT"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} Enter

# verify send landed
sleep 0.3
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":work.{top} -S -10 \
  | grep -qF "$APPROVED_PROMPT" && echo "SEND OK" || echo "SEND FAILED"

# wait for Claude to respond
.github/skills/tmux/scripts/wait-for-text.sh \
  -S "$SOCKET" -t "$SESSION":work.{top} -p 'ready|Done|❯|\$' -T 60
```

**Handoff rules:**
- Never copy-paste Codex output to Claude without reading it first.
- Never automate the Codex→Claude relay. The human is the firewall.
- If Codex suggests something that contradicts the approved plan or AGENTS.md, reject it.
- If the upward prompt changes scope, the human must decide whether to proceed or replan.

### Interrupt and Reset

If either agent drifts off-task or produces unexpected output:

```bash
# interrupt an agent
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} C-c

# if agent is hung, kill its process
PANE_PID=$(tmux -S "$SOCKET" display-message -t "$SESSION":work.{top} -p '#{pane_pid}')
kill -9 "$PANE_PID"

# relaunch in the same pane
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} -l -- "claude"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} Enter
```

### Self-Test Procedure

Run this end-to-end smoke test to verify the lane works before starting real work.

**Prerequisites**: tmux installed, a git repo with `.worktrees/` gitignored.

```bash
# --- Setup ---
SOCKET_DIR="${VIBES_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/vibes-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/vibes.sock"
SESSION="selftest"

# 1. Create session with split panes
tmux -S "$SOCKET" new-session -d -s "$SESSION" -n work
tmux -S "$SOCKET" split-window -v -t "$SESSION":work

# 2. Verify pane targeting — send canary to top pane
CANARY_TOP="CANARY_TOP_$$"
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} -l -- "echo $CANARY_TOP"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} Enter
sleep 0.5
TOP_CONTENT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":work.{top} -S -5)
echo "$TOP_CONTENT" | grep -qF "$CANARY_TOP" \
  && echo "PASS: top pane targeting works" \
  || echo "FAIL: canary not found in top pane"

# 3. Verify pane targeting — send canary to bottom pane
CANARY_BOT="CANARY_BOT_$$"
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{bottom} -l -- "echo $CANARY_BOT"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{bottom} Enter
sleep 0.5
BOT_CONTENT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":work.{bottom} -S -5)
echo "$BOT_CONTENT" | grep -qF "$CANARY_BOT" \
  && echo "PASS: bottom pane targeting works" \
  || echo "FAIL: canary not found in bottom pane"

# 4. Verify cross-pane isolation — top canary must NOT be in bottom pane
echo "$BOT_CONTENT" | grep -qF "$CANARY_TOP" \
  && echo "FAIL: top canary leaked into bottom pane" \
  || echo "PASS: panes are isolated"

# 5. Simulate upward-prompt handoff
#    In real use, Codex writes a suggestion in the bottom pane.
#    Human reads it, rewrites it, sends it to the top pane.
SIMULATED_PROMPT="echo UPWARD_HANDOFF_OK"
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} -l -- "$SIMULATED_PROMPT"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":work.{top} Enter
sleep 0.5
HANDOFF_CONTENT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":work.{top} -S -5)
echo "$HANDOFF_CONTENT" | grep -qF "UPWARD_HANDOFF_OK" \
  && echo "PASS: upward handoff landed and executed in top pane" \
  || echo "FAIL: upward handoff did not execute in top pane"

# 6. Verify wait-for-text helper works
.github/skills/tmux/scripts/wait-for-text.sh \
  -S "$SOCKET" -t "$SESSION":work.{top} -p 'UPWARD_HANDOFF_OK' -T 5 \
  && echo "PASS: wait-for-text detected expected output" \
  || echo "FAIL: wait-for-text timed out"

# --- Cleanup ---
tmux -S "$SOCKET" kill-session -t "$SESSION"
echo "Self-test complete."
```

**Pass criteria**: All 5 checks print PASS. Any FAIL means the lane is not correctly set up — fix the failing step before proceeding with real work.

## Live Supervision Workflow

Use this when a user wants to watch a single agent run and intervene live (simpler than the full Claude+Codex lane).

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

## Worktree Integration

For filesystem isolation between agents, use the `using-git-worktrees` skill to create worktrees before starting tmux sessions. Do not duplicate worktree creation logic here.

**Pattern**: one worktree per agent, one tmux session (or pane) per worktree.

```bash
# create worktree (using-git-worktrees skill handles branch naming,
# .gitignore safety, and dependency install)
WORK_DIR=".worktrees/feat/my-feature"

# start agent in that worktree
tmux -S "$SOCKET" new-session -d -s my-agent -n shell -c "$WORK_DIR"
```

For multi-agent orchestration with worktrees, combine the `using-git-worktrees` and `dispatching-parallel-agents` skills.

## Helpers

Use bundled scripts:

- `scripts/find-sessions.sh` to inspect sessions/sockets.
- `scripts/wait-for-text.sh` to wait for a prompt or ready marker.

Both scripts support `-S` (socket path) and `-L` (socket name) flags.

Examples:

```bash
.github/skills/tmux/scripts/find-sessions.sh -S "$SOCKET"
.github/skills/tmux/scripts/wait-for-text.sh -S "$SOCKET" -t "$SESSION":shell -p 'ready|Done|❯|\\$'
```

## Cleanup

```bash
tmux -S "$SOCKET" kill-session -t "$SESSION"
tmux -S "$SOCKET" kill-server
# clean up worktrees via: git worktree remove "$WORKTREE_DIR/$BRANCH"
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
