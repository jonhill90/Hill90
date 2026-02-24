"""Command and path policy enforcement for sandboxed agent execution."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess


class CommandPolicy:
    """Validates and executes commands against an allowlist/denylist policy."""

    def __init__(
        self,
        allowed_binaries: list[str] | None = None,
        denied_patterns: list[str] | None = None,
        max_timeout: int = 300,
    ):
        self.allowed = set(allowed_binaries or [])
        self.denied = [re.compile(p) for p in (denied_patterns or [])]
        self.max_timeout = max_timeout

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

    def execute(self, command: str, timeout: int = 30, cwd: str = "/workspace") -> dict:
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
