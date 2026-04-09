"""Command and path policy enforcement for sandboxed agent execution."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import threading
from typing import Callable


class CommandPolicy:
    """Validates and executes commands against an allowlist/denylist policy."""

    def __init__(
        self,
        allowed_binaries: list[str] | None = None,
        denied_patterns: list[str] | None = None,
        max_timeout: int = 300,
    ):
        self.allowed = self._resolve_binaries(allowed_binaries or [])
        self.denied = [re.compile(p) for p in (denied_patterns or [])]
        self.max_timeout = max_timeout

    @staticmethod
    def _resolve_binaries(names: list[str]) -> set[str]:
        """Resolve binary names to absolute paths for allowlist comparison.

        Accepts both short names (e.g. "bash") and absolute paths
        (e.g. "/usr/bin/bash"). Short names are resolved via PATH lookup;
        entries that cannot be resolved are kept as-is.
        """
        resolved = set()
        for name in names:
            path = shutil.which(name) if not os.path.isabs(name) else name
            if path:
                resolved.add(os.path.realpath(path))
            else:
                # Keep unresolvable names so the set isn't silently empty
                resolved.add(name)
        return resolved

    def check(self, command: str) -> tuple[bool, str]:
        """Check if a command is allowed by policy. Returns (allowed, reason)."""
        # Deny patterns on raw input first
        for pattern in self.denied:
            if pattern.search(command):
                return False, "Command matches denied pattern"

        # Parse to get binary
        try:
            argv = shlex.split(command)
        except ValueError:
            return False, "Could not parse command"
        if not argv:
            return False, "Empty command"

        # Resolve binary to absolute path and check allowlist
        if self.allowed:
            binary = argv[0]
            resolved = shutil.which(binary) or binary
            resolved = os.path.realpath(resolved)
            if resolved not in self.allowed:
                return False, f"Binary '{binary}' ({resolved}) not in allowlist"

        return True, "ok"

    def build_argv_and_env(self, command: str, cwd: str = "/home/agentuser") -> tuple[list[str], dict[str, str]] | tuple[None, str]:
        """Validate command and return (argv, env) or (None, error_reason)."""
        allowed, reason = self.check(command)
        if not allowed:
            return None, reason

        argv = shlex.split(command)
        safe_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": cwd,
            "LANG": "C.UTF-8",
            "TERM": "xterm-256color",
        }
        return (argv, safe_env), ""

    def execute(self, command: str, timeout: int = 30, cwd: str = "/home/agentuser") -> dict:
        """Execute command with shell=False, explicit argv, restricted env, pinned cwd."""
        allowed, reason = self.check(command)
        if not allowed:
            return {"success": False, "error": reason}

        argv = shlex.split(command)
        timeout = min(max(timeout, 1), self.max_timeout)

        # Minimal env — no inherited secrets
        safe_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": cwd,
            "LANG": "C.UTF-8",
            "TERM": "xterm",
        }

        try:
            result = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=safe_env,
                shell=False,
            )
            return {
                "success": result.returncode == 0,
                "exit_code": result.returncode,
                "stdout": result.stdout[:100_000],
                "stderr": result.stderr[:10_000],
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "error": f"Timed out after {timeout}s"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def execute_streaming(
        self,
        command: str,
        timeout: int = 30,
        cwd: str = "/home/agentuser",
        on_output: Callable[[str], None] | None = None,
        max_line_len: int = 4096,
        max_lines: int = 1000,
    ) -> dict:
        """Execute command with line-by-line stdout streaming via on_output callback.

        Stdout lines are delivered to on_output as they're produced. The final
        result dict (same shape as execute()) is returned after the process exits.

        Args:
            command: Shell command string.
            timeout: Max seconds before kill.
            cwd: Working directory.
            on_output: Called with each stdout line (stripped). None to skip streaming.
            max_line_len: Truncate individual lines to this length.
            max_lines: Stop emitting after this many lines (process continues).
        """
        allowed, reason = self.check(command)
        if not allowed:
            return {"success": False, "error": reason}

        argv = shlex.split(command)
        timeout = min(max(timeout, 1), self.max_timeout)

        safe_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": cwd,
            "LANG": "C.UTF-8",
            "TERM": "xterm",
        }

        try:
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=cwd,
                env=safe_env,
                shell=False,
            )

            # Timeout via timer
            timed_out = threading.Event()

            def _kill():
                timed_out.set()
                proc.kill()

            timer = threading.Timer(timeout, _kill)
            timer.start()

            # Stream stdout line-by-line
            stdout_parts: list[str] = []
            lines_emitted = 0
            try:
                for raw_line in proc.stdout:  # type: ignore[union-attr]
                    line = raw_line.rstrip("\n")
                    if len(line) > max_line_len:
                        line = line[:max_line_len]
                    stdout_parts.append(raw_line)
                    if on_output and lines_emitted < max_lines:
                        on_output(line)
                        lines_emitted += 1
            except ValueError:
                pass  # stdout closed

            stderr = proc.stderr.read() if proc.stderr else ""  # type: ignore[union-attr]
            proc.wait()
            timer.cancel()

            if timed_out.is_set():
                return {"success": False, "error": f"Timed out after {timeout}s"}

            stdout = "".join(stdout_parts)
            return {
                "success": proc.returncode == 0,
                "exit_code": proc.returncode,
                "stdout": stdout[:100_000],
                "stderr": stderr[:10_000],
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


class PathPolicy:
    """Validates file paths against allowed/denied lists with symlink resolution."""

    def __init__(
        self,
        allowed_paths: list[str] | None = None,
        denied_paths: list[str] | None = None,
        read_only: bool = False,
    ):
        self.allowed = [os.path.realpath(p) for p in (allowed_paths or ["/workspace"])]
        self.denied = [os.path.realpath(p) for p in (denied_paths or [])]
        self.read_only = read_only

    def check_read(self, path: str) -> tuple[bool, str]:
        """Check if a path is allowed for reading."""
        real = os.path.realpath(path)

        for denied in self.denied:
            if real == denied or real.startswith(denied + "/"):
                return False, f"Path '{path}' is in denied list"

        for allowed in self.allowed:
            if real == allowed or real.startswith(allowed + "/"):
                return True, "ok"

        return False, f"Path '{path}' is not in allowed paths"

    def check_write(self, path: str) -> tuple[bool, str]:
        """Check if a path is allowed for writing."""
        if self.read_only:
            return False, "Filesystem is read-only"
        return self.check_read(path)
