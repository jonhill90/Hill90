"""WebSocket terminal — bidirectional PTY relay over WebSocket.

Spawns a tmux session (with zsh) in a PTY and relays stdin/stdout
between the WebSocket and the PTY master fd. If tmux is not available,
falls back to zsh, then bash. Supports terminal resize via JSON
control messages.

Wire format:
  - Binary frames: raw terminal I/O (stdin from client, stdout to client)
  - Text frames: JSON control messages
    - {"type": "resize", "cols": 120, "rows": 40}
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pty
import select
import shutil
import signal
import struct
import termios

from starlette.websockets import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

TERM_COLS = 120
TERM_ROWS = 40
READ_SIZE = 4096
TMUX_SESSION = "agent"


def _resolve_shell() -> tuple[list[str], str]:
    """Resolve the best available shell command.

    Prefers: tmux new-session (zsh) > zsh > bash.
    Returns (argv, shell_path) for execvpe.
    """
    tmux = shutil.which("tmux")
    zsh = shutil.which("zsh")
    bash = shutil.which("bash") or "/bin/bash"

    if tmux and zsh:
        # tmux with zsh as default-shell, attach or create session
        return (
            [tmux, "new-session", "-A", "-s", TMUX_SESSION,
             "-x", str(TERM_COLS), "-y", str(TERM_ROWS)],
            tmux,
        )
    if zsh:
        return ([zsh, "--login"], zsh)
    return ([bash, "--login"], bash)


async def ws_terminal_handler(websocket: WebSocket, work_token: str | None) -> None:
    """Handle a WebSocket terminal session.

    Auth: Bearer token in query param ?token=<WORK_TOKEN>.
    """
    # Auth check
    token = websocket.query_params.get("token", "")
    if not work_token or token != work_token:
        await websocket.close(code=4001, reason="unauthorized")
        return

    await websocket.accept()

    master_fd = -1
    pid = -1

    try:
        master_fd, slave_fd = pty.openpty()

        # Set terminal size
        winsize = struct.pack("HHHH", TERM_ROWS, TERM_COLS, 0, 0)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

        pid = os.fork()

        if pid == 0:
            # Child process — become session leader, exec shell
            os.setsid()
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            os.close(master_fd)
            os.close(slave_fd)

            try:
                os.chdir("/workspace")
            except OSError:
                pass

            argv, shell_bin = _resolve_shell()

            env = {
                "PATH": "/home/agentuser/.local/bin:/usr/local/bin:/usr/bin:/bin",
                "HOME": "/home/agentuser",
                "LANG": "C.UTF-8",
                "TERM": "xterm-256color",
                "SHELL": shutil.which("zsh") or shutil.which("bash") or "/bin/bash",
            }

            try:
                os.execvpe(shell_bin, argv, env)
            except OSError as e:
                os.write(2, f"exec failed: {e}\n".encode())
                os._exit(127)

        # Parent process
        os.close(slave_fd)

        # Non-blocking reads on master
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        # Start reader task (PTY → WebSocket)
        reader_task = asyncio.create_task(
            _pty_reader(master_fd, websocket)
        )

        # Main loop: WebSocket → PTY
        try:
            while True:
                message = await websocket.receive()

                if message.get("type") == "websocket.disconnect":
                    break

                if "bytes" in message and message["bytes"]:
                    # Binary frame: raw terminal input
                    os.write(master_fd, message["bytes"])

                elif "text" in message and message["text"]:
                    # Text frame: control message
                    try:
                        ctrl = json.loads(message["text"])
                        if ctrl.get("type") == "resize":
                            cols = int(ctrl.get("cols", TERM_COLS))
                            rows = int(ctrl.get("rows", TERM_ROWS))
                            winsize = struct.pack("HHHH", rows, cols, 0, 0)
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                            # Signal the shell about the resize
                            os.kill(pid, signal.SIGWINCH)
                    except (json.JSONDecodeError, ValueError, OSError):
                        pass

        except WebSocketDisconnect:
            pass
        finally:
            reader_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass

    except Exception as exc:
        logger.error("Terminal WebSocket error: %s", exc, exc_info=True)
    finally:
        # Cleanup: kill shell, close fd
        if master_fd >= 0:
            try:
                os.close(master_fd)
            except OSError:
                pass

        if pid > 0:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass


async def _pty_reader(master_fd: int, websocket: WebSocket) -> None:
    """Read from PTY master fd and send to WebSocket as binary frames."""
    loop = asyncio.get_event_loop()

    try:
        while True:
            # Wait for data using asyncio-compatible fd watching
            ready = await loop.run_in_executor(
                None, lambda: select.select([master_fd], [], [], 0.1)
            )

            if ready[0]:
                try:
                    data = os.read(master_fd, READ_SIZE)
                    if not data:
                        break
                    await websocket.send_bytes(data)
                except OSError:
                    break
            else:
                # Check if the process is still alive by trying a non-blocking read
                await asyncio.sleep(0)

    except (asyncio.CancelledError, WebSocketDisconnect):
        pass
    except Exception as exc:
        logger.debug("PTY reader stopped: %s", exc)
