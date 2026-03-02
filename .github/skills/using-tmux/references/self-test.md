# using-tmux Self-Test

Deterministic smoke test for verifying tmux mechanics in a fresh session. Run this to confirm pane targeting, send verification, and helpers work correctly.

## Prerequisites

- tmux installed (`tmux -V`)
- `wait-for-text.sh` script available at `scripts/wait-for-text.sh` relative to this file's skill directory

## Procedure

Run these commands sequentially. Each check prints `PASS` or `FAIL`.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAIT_SCRIPT="$SCRIPT_DIR/scripts/wait-for-text.sh"

SOCKET_DIR="${TMPDIR:-/tmp}/using-tmux-selftest-$$"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/test.sock"
SESSION="selftest"
PASS=0
FAIL=0
TOTAL=8

cleanup() {
  tmux -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SOCKET_DIR"
}
trap cleanup EXIT

check() {
  local name="$1" result="$2"
  if [[ "$result" == "PASS" ]]; then
    echo "  [$result] $name"
    ((PASS++))
  else
    echo "  [$result] $name"
    ((FAIL++))
  fi
}

echo "=== using-tmux self-test ==="
echo ""

# --- Check 1: Session and window creation ---
tmux -S "$SOCKET" new-session -d -s "$SESSION" -n shell
if tmux -S "$SOCKET" list-sessions 2>/dev/null | grep -q "$SESSION"; then
  check "Session + window creation" "PASS"
else
  check "Session + window creation" "FAIL"
fi

# --- Check 2: Split into two panes ---
tmux -S "$SOCKET" split-window -v -t "$SESSION":shell
PANE_COUNT=$(tmux -S "$SOCKET" list-panes -t "$SESSION":shell | wc -l | tr -d ' ')
if [[ "$PANE_COUNT" -eq 2 ]]; then
  check "Split into two panes" "PASS"
else
  check "Split into two panes" "FAIL"
fi

# --- Check 3: Explicit targeting of top pane ---
CANARY_TOP="CANARY_TOP_$$"
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} -l -- "echo $CANARY_TOP"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} Enter
sleep 0.5
TOP_OUTPUT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{top} -S -10)
if echo "$TOP_OUTPUT" | grep -q "$CANARY_TOP"; then
  check "Explicit targeting — top pane" "PASS"
else
  check "Explicit targeting — top pane" "FAIL"
fi

# --- Check 4: Explicit targeting of bottom pane ---
CANARY_BOTTOM="CANARY_BOTTOM_$$"
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{bottom} -l -- "echo $CANARY_BOTTOM"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{bottom} Enter
sleep 0.5
BOTTOM_OUTPUT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{bottom} -S -10)
if echo "$BOTTOM_OUTPUT" | grep -q "$CANARY_BOTTOM"; then
  check "Explicit targeting — bottom pane" "PASS"
else
  check "Explicit targeting — bottom pane" "FAIL"
fi

# --- Check 5: Cross-pane isolation ---
# Top canary must NOT appear in bottom pane output
if echo "$BOTTOM_OUTPUT" | grep -q "$CANARY_TOP"; then
  check "Cross-pane isolation" "FAIL"
else
  check "Cross-pane isolation" "PASS"
fi

# --- Check 6: Send verification procedure ---
CANARY_VERIFY="VERIFY_$$"
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} -l -- "echo $CANARY_VERIFY"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} Enter
sleep 0.3
VERIFY_OUTPUT=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{top} -S -10)
if echo "$VERIFY_OUTPUT" | grep -q "$CANARY_VERIFY"; then
  check "Send verification (capture-after-send)" "PASS"
else
  check "Send verification (capture-after-send)" "FAIL"
fi

# --- Check 7: wait-for-text.sh helper works ---
CANARY_WAIT="WAITFOR_$$"
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} -l -- "sleep 1 && echo $CANARY_WAIT"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} Enter
if "$WAIT_SCRIPT" -S "$SOCKET" -t "$SESSION":shell.{top} -p "$CANARY_WAIT" -T 5; then
  check "wait-for-text.sh helper" "PASS"
else
  check "wait-for-text.sh helper" "FAIL"
fi

# --- Check 8: Wrong-target recovery ---
CANARY_WRONG="WRONG_$$"
# Send to bottom (simulating wrong target)
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{bottom} -l -- "echo $CANARY_WRONG"
sleep 0.1
tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{bottom} Enter
sleep 0.3
# Detect: text is absent from top (intended target)
TOP_CHECK=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{top} -S -10)
# Detect: text is present in bottom (wrong target)
BOTTOM_CHECK=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{bottom} -S -10)
if ! echo "$TOP_CHECK" | grep -q "$CANARY_WRONG" && echo "$BOTTOM_CHECK" | grep -q "$CANARY_WRONG"; then
  # Recovery: re-send to top (correct target)
  tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} -l -- "echo $CANARY_WRONG"
  sleep 0.1
  tmux -S "$SOCKET" send-keys -t "$SESSION":shell.{top} Enter
  sleep 0.3
  TOP_RECOVERY=$(tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":shell.{top} -S -10)
  if echo "$TOP_RECOVERY" | grep -q "$CANARY_WRONG"; then
    check "Wrong-target recovery" "PASS"
  else
    check "Wrong-target recovery" "FAIL"
  fi
else
  check "Wrong-target recovery" "FAIL"
fi

# --- Summary ---
echo ""
echo "=== $PASS/$TOTAL checks passed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "$FAIL check(s) FAILED"
  exit 1
fi
```

## Running the Self-Test

From the repository root:

```bash
bash .github/skills/using-tmux/references/self-test.md
```

Or extract the script block and run it directly. The test creates an isolated tmux socket (unique per PID), runs all checks, and cleans up on exit.

## Expected Output

```
=== using-tmux self-test ===

  [PASS] Session + window creation
  [PASS] Split into two panes
  [PASS] Explicit targeting — top pane
  [PASS] Explicit targeting — bottom pane
  [PASS] Cross-pane isolation
  [PASS] Send verification (capture-after-send)
  [PASS] wait-for-text.sh helper
  [PASS] Wrong-target recovery

=== 8/8 checks passed ===
```
