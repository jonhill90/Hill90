# Agent Terminal Streaming Protocol — PTY + SSE Design

**Linear:** AI-154 | **Status:** Design | **Date:** 2026-04-04

## 1. Problem

Agent command execution is currently **blind until completion**. The agentbox shell runner (`shell.py`) uses `subprocess.run(capture_output=True)`, which blocks until the command finishes and returns the full stdout/stderr as a single payload. For long-running commands (builds, deployments, test suites), the human sees nothing for minutes, then a wall of text.

The platform needs real-time terminal output streaming so humans can watch agent work as it happens.

## 2. Goals

1. Stream agent command output to the browser in real time via SSE.
2. Use PTY (pseudo-terminal) to capture output as it would appear in a real terminal — including interactive programs, progress bars, and colored output.
3. Support reconnection with cursor-based resumption (no duplicate output, no gaps).
4. Maintain security boundaries — output is scoped to the agent's container, no cross-agent leakage.
5. Fit cleanly into the existing SSE infrastructure (chat stream, event stream, log stream patterns).

## 3. Non-Goals (MVP)

- Terminal input (stdin) from the browser. This is output-only streaming.
- ANSI escape code rendering in the browser (Phase 2 — use `xterm.js`).
- Multiple concurrent PTY sessions per agent.
- Scrollback buffer persistence beyond the SSE reconnection window.

## 4. Architecture Overview

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐     ┌─────────┐
│   Browser    │ SSE │   API Service │ SSE │  Agentbox    │ PTY │ Command │
│  (EventSource)◄────┤  /agents/:id/ │◄────┤  /terminal   │◄────┤ Process │
│              │     │  terminal     │     │  stream      │     │         │
└──────────────┘     └───────────────┘     └──────────────┘     └─────────┘
                     Keycloak JWT          Container-local       Fork + exec
                     + ownership scope     Ed25519 JWT            via PTY
```

**Data flow:** Command process → PTY master fd → agentbox read loop → SSE events → API proxy → browser EventSource.

## 5. PTY Setup in Python (Agentbox)

### 5.1 Why PTY, Not Pipes

| Feature | `subprocess.PIPE` | PTY (`pty.openpty()`) |
|---------|-------------------|----------------------|
| Line buffering | Programs detect non-TTY and use 4KB blocks | Programs detect TTY and flush per-line |
| Progress bars | Broken (no `\r` handling) | Work correctly |
| Colored output | Some programs skip colors on non-TTY | ANSI colors emitted naturally |
| Interactive prompts | Invisible until completion | Visible in real time |

### 5.2 Implementation: `pty_shell.py`

```python
"""PTY-based shell execution with streaming output."""

import os
import pty
import select
import signal
import struct
import fcntl
import termios
from typing import Generator

# Terminal size: 120 cols × 40 rows (reasonable for agent work)
TERM_COLS = 120
TERM_ROWS = 40
READ_SIZE = 4096  # bytes per read
SELECT_TIMEOUT = 0.1  # 100ms poll interval


def execute_streaming(
    command: list[str],
    env: dict[str, str],
    cwd: str = "/workspace",
    timeout: int = 300,
) -> Generator[bytes, None, tuple[int, bool]]:
    """Execute command in PTY, yielding output chunks as they arrive.

    Yields bytes chunks. Returns (exit_code, timed_out) when done.
    """
    master_fd, slave_fd = pty.openpty()

    # Set terminal size
    winsize = struct.pack("HHHH", TERM_ROWS, TERM_COLS, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    pid = os.fork()

    if pid == 0:
        # Child process
        os.setsid()
        os.dup2(slave_fd, 0)  # stdin
        os.dup2(slave_fd, 1)  # stdout
        os.dup2(slave_fd, 2)  # stderr
        os.close(master_fd)
        os.close(slave_fd)
        os.chdir(cwd)
        os.execvpe(command[0], command, env)

    # Parent process
    os.close(slave_fd)

    # Set master_fd to non-blocking
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    elapsed = 0.0
    timed_out = False

    try:
        while True:
            ready, _, _ = select.select([master_fd], [], [], SELECT_TIMEOUT)
            if ready:
                try:
                    data = os.read(master_fd, READ_SIZE)
                    if not data:
                        break
                    yield data
                except OSError:
                    break
            else:
                elapsed += SELECT_TIMEOUT
                if elapsed >= timeout:
                    os.kill(pid, signal.SIGKILL)
                    timed_out = True
                    break

            # Check if child exited
            result = os.waitpid(pid, os.WNOHANG)
            if result[0] != 0:
                # Drain remaining output
                while True:
                    ready, _, _ = select.select([master_fd], [], [], 0.05)
                    if not ready:
                        break
                    try:
                        data = os.read(master_fd, READ_SIZE)
                        if not data:
                            break
                        yield data
                    except OSError:
                        break
                exit_code = os.WEXITSTATUS(result[1]) if os.WIFEXITED(result[1]) else -1
                return (exit_code, False)
    finally:
        os.close(master_fd)

    if timed_out:
        os.waitpid(pid, 0)
        return (-1, True)

    _, status = os.waitpid(pid, 0)
    exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
    return (exit_code, False)
```

### 5.3 Key Design Decisions

- **`os.fork()` + `os.execvpe()`** instead of `subprocess.Popen` — direct PTY control, no Python subprocess overhead.
- **Non-blocking master_fd** — prevents blocking on slow output, enables timeout enforcement.
- **`select.select()` with 100ms timeout** — balances latency vs CPU. Output arrives within 100ms of generation.
- **Drain after exit** — child process may have buffered output; drain before closing.
- **No `shell=True`** — command is a list, executed directly. Shell policy enforcement happens before this function is called.

## 6. Output Buffering and Framing

### 6.1 Agentbox SSE Endpoint

New endpoint: `GET /terminal/stream` (on the agentbox internal API, container-local).

**Not a new endpoint.** Instead, the existing event log mechanism is extended. When a shell command runs with PTY, output chunks are written to a dedicated JSONL file: `/var/log/agentbox/terminal.jsonl`.

Each line:
```json
{"seq": 1, "ts": "2026-04-04T12:00:00.123Z", "type": "output", "data": "base64-encoded-bytes"}
{"seq": 2, "ts": "2026-04-04T12:00:00.234Z", "type": "output", "data": "base64..."}
{"seq": 3, "ts": "2026-04-04T12:00:01.000Z", "type": "exit", "exit_code": 0, "timed_out": false}
```

### 6.2 Why Base64

Terminal output is arbitrary bytes (ANSI escape codes, binary fragments from progress bars, UTF-8 mixed with control chars). JSON requires string encoding. Base64 is the safe, lossless choice.

### 6.3 Buffering Strategy

Output from the PTY is chunked by the `READ_SIZE` (4KB) and `select` timing (100ms). To avoid tiny SSE events for each keystroke:

- **Coalesce buffer**: accumulate output for up to **200ms** before flushing to JSONL.
- **Flush on newline**: if a `\n` is received, flush immediately (most common case — line-oriented output).
- **Flush on size**: if buffer exceeds **8KB**, flush immediately (prevents memory buildup for binary output).
- **Flush on exit**: drain and flush all remaining output when process exits.

This gives sub-200ms latency for interactive output while avoiding event storms.

### 6.4 Sequence Numbers

Each JSONL line gets a monotonically increasing `seq` integer (per command execution). This is the SSE cursor — clients reconnect with `Last-Event-ID: {seq}` and receive only events after that point.

Sequence resets to 0 on each new command execution. The combination of `(command_id, seq)` is globally unique.

## 7. SSE Event Format

### 7.1 API Proxy Endpoint

New endpoint: `GET /agents/:id/terminal` (on the API service).

**Auth:** Keycloak JWT + `requireRole('user')` + ownership scope.

**Implementation:** `tail -f /var/log/agentbox/terminal.jsonl` via `docker exec`, same pattern as the existing events endpoint.

### 7.2 Event Types

```
# Output chunk (most common)
id: 42
event: output
data: {"seq":42,"ts":"2026-04-04T12:00:00.123Z","data":"base64...","command_id":"cmd-abc"}

# Command started
id: 0
event: command_start
data: {"seq":0,"command_id":"cmd-abc","command":"npm test","ts":"2026-04-04T12:00:00.000Z"}

# Command completed
id: 99
event: command_exit
data: {"seq":99,"command_id":"cmd-abc","exit_code":0,"timed_out":false,"ts":"2026-04-04T12:00:05.000Z"}

# Heartbeat (every 30s, no id/data)
: heartbeat
```

### 7.3 Client Reconnection

```javascript
const es = new EventSource(`/api/agents/${id}/terminal`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// On reconnect, browser automatically sends Last-Event-ID header
// API reads cursor from Last-Event-ID, seeks in JSONL, sends remaining events
```

**Reconnection strategy:**
- `Last-Event-ID` = last received `seq` value
- API reads terminal.jsonl, skips lines with `seq <= cursor`
- Then switches to `tail -f` for live streaming
- If JSONL file has been rotated (new command started), send `event: reset` to signal client should clear display

### 7.4 Connection Lifecycle

```
Client connects → API validates auth + ownership
  → docker exec tail -f terminal.jsonl in agent container
  → line buffer: parse JSON, validate seq, write SSE event
  → heartbeat every 30s
  → on container stop: event: end + res.end()
  → on client disconnect: cleanup streams + intervals
```

## 8. Security Boundaries

### 8.1 Authentication Chain

```
Browser ──[Keycloak JWT]──→ API Service ──[Docker exec]──→ Agentbox Container
                             ↓
                    scopeToOwner(req)
                    verify agent ownership
```

- **No cross-agent access.** The API verifies the requesting user owns the agent before proxying.
- **No direct container access.** Browsers never connect to the container directly.
- **Docker exec scoping.** The API runs `docker exec` targeting the specific agent's container by `agent_id`. Container isolation prevents access to other containers.

### 8.2 Output Sanitization

- Terminal output is **base64-encoded**, preventing injection of SSE control characters (`\n\n`, `event:`, `data:`) into the event stream.
- The API proxy validates each line is valid JSON before forwarding. Non-JSON lines (container noise) are silently dropped.
- No input channel — this is strictly output streaming. The agent decides what commands to run; the human only observes.

### 8.3 Rate Limiting

- **Per-connection limit**: 1 terminal SSE connection per agent per user. New connection closes the previous one.
- **Output volume**: JSONL file rotation at 10MB. Old data discarded. Terminal streaming is ephemeral, not archival.
- **Idle timeout**: If no output for 5 minutes and agent is stopped, close the SSE connection.

### 8.4 What Is NOT Exposed

- Agent environment variables (redacted in command display if needed)
- Internal container paths beyond `/workspace`
- Other containers' output
- PTY input (no stdin forwarding in MVP)

## 9. UI Integration

### 9.1 Agent Detail Page

New sub-view under the Activity tab: **Terminal** (alongside Events and Logs).

```
Activity Tab
├── Events (existing)
├── Logs (existing, admin-only)
└── Terminal (new)
```

### 9.2 MVP: Pre-Formatted Text

For MVP, terminal output is rendered as `<pre>` with `whitespace-pre-wrap`. Base64-decoded, displayed as-is (ANSI codes stripped client-side with a simple regex).

### 9.3 Phase 2: xterm.js

Replace `<pre>` with `xterm.js` terminal emulator widget. Decodes ANSI escapes properly (colors, cursor movement, progress bars). `xterm.js` accepts raw terminal bytes and renders them faithfully.

## 10. File Changes (Implementation)

| Step | File | Description |
|------|------|-------------|
| 1 | `services/agentbox/app/pty_shell.py` | PTY execution with streaming generator |
| 2 | `services/agentbox/app/runtime.py` | Wire PTY into work handler, write terminal.jsonl |
| 3 | `services/agentbox/app/shell.py` | Add `execute_streaming()` alongside existing `execute_command()` |
| 4 | `services/api/src/routes/agents.ts` | `GET /agents/:id/terminal` SSE endpoint |
| 5 | `services/api/src/openapi/openapi.yaml` | Add terminal endpoint to spec |
| 6 | `services/ui/src/app/agents/[id]/AgentDetailClient.tsx` | Terminal sub-view under Activity |
| 7 | `services/ui/src/app/agents/[id]/TerminalView.tsx` | SSE consumer + output renderer |
| 8 | Tests | Unit tests for pty_shell (mock fork), vitest for TerminalView |

**Estimated file count:** 8-10 new/modified files.

## 11. Comparison with Existing SSE Patterns

| Aspect | Chat Stream | Agent Events | Terminal Stream |
|--------|-------------|--------------|-----------------|
| **Source** | PostgreSQL polling | Container JSONL + DB | Container JSONL |
| **Cursor** | `chat_messages.seq` | timestamp + id | `seq` integer |
| **Poll interval** | 1s | 3s (inference) | N/A (tail -f) |
| **Heartbeat** | 30s | 30s | 30s |
| **Encoding** | JSON text | JSON text | JSON + base64 payload |
| **End signal** | Implicit | `event: end` | `event: end` |
| **Reconnection** | `Last-Event-ID` | Tail backfill | `Last-Event-ID` + seek |
| **Buffering** | N/A (DB rows) | Line buffer | Coalesce (200ms / 8KB / newline) |

## 12. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| PTY fork in Python adds complexity | Maintenance burden | Isolate in `pty_shell.py`, thorough unit tests, fallback to existing `subprocess.run` if PTY fails |
| High-volume output (e.g., `find /`) floods SSE | Browser lag, memory | 10MB JSONL rotation, client-side virtual scrolling in Phase 2 |
| Base64 overhead (~33% size increase) | Bandwidth | Terminal output is text-heavy; 33% overhead on typical output is negligible |
| ANSI escape codes in `<pre>` look ugly | UX | Strip ANSI in MVP, proper rendering with xterm.js in Phase 2 |
| `os.fork()` in threaded Python | Potential deadlocks | Agentbox is single-threaded asyncio; PTY exec runs in thread pool executor with no shared locks |
