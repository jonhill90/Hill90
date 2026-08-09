"""Small tmux transport; terminal output stays inside the adapter process."""

from __future__ import annotations

import subprocess
import time


TMUX_TIMEOUT_SECONDS = 10


class TmuxTransport:
    def __init__(self, tmux_bin="tmux", *, timeout=TMUX_TIMEOUT_SECONDS):
        self.tmux_bin = tmux_bin
        self.timeout = timeout

    def _run(self, *args, check=True):
        return subprocess.run(
            [self.tmux_bin, *args],
            check=check,
            capture_output=True,
            text=True,
            timeout=self.timeout,
        )

    def metadata(self, target):
        fmt = "#{pane_id}|#{pane_current_command}|#{pane_current_path}|#{socket_path}|#{session_created}|#{session_id}"
        output = self._run("display-message", "-p", "-t", target, fmt).stdout.rstrip("\n")
        pane_id, command, path, socket_path, session_created, session_id = output.split("|", 5)
        return {
            "pane_id": pane_id,
            "command": command,
            "path": path,
            "server_id": f"{socket_path}:{session_created}",
            "session_id": session_id,
        }

    def capture(self, target, lines=25):
        return self._run("capture-pane", "-p", "-J", "-t", target, "-S", f"-{int(lines)}").stdout

    def set_option(self, target, name, value):
        self._run("set-option", "-p", "-t", target, name, value)

    def get_option(self, target, name):
        return self._run("display-message", "-p", "-t", target, f"#{{{name}}}").stdout.rstrip("\n")

    def send_literal(self, target, payload):
        self._run("send-keys", "-t", target, "C-u")
        self._run("send-keys", "-t", target, "-l", "--", payload)
        time.sleep(0.1)
        self._run("send-keys", "-t", target, "Enter")
        time.sleep(0.5)
