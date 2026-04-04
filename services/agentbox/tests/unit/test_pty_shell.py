"""Unit tests for PTY shell execution."""

import os
import sys

import pytest

from app.pty_shell import PtyResult, execute_streaming


class TestExecuteStreaming:
    def test_simple_echo(self):
        """PTY captures echo output."""
        chunks: list[bytes] = []
        gen = execute_streaming(
            ["echo", "hello PTY"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=10,
        )
        result = None
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration as e:
            result = e.value

        output = b"".join(chunks).decode("utf-8", errors="replace")
        assert "hello PTY" in output
        assert isinstance(result, PtyResult)
        assert result.exit_code == 0
        assert result.timed_out is False

    def test_exit_code_nonzero(self):
        """PTY captures non-zero exit codes."""
        gen = execute_streaming(
            ["sh", "-c", "exit 42"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=10,
        )
        result = None
        try:
            while True:
                next(gen)
        except StopIteration as e:
            result = e.value

        assert result is not None
        assert result.exit_code == 42
        assert result.timed_out is False

    def test_timeout(self):
        """PTY enforces timeout."""
        gen = execute_streaming(
            ["sleep", "60"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=1,
        )
        result = None
        try:
            while True:
                next(gen)
        except StopIteration as e:
            result = e.value

        assert result is not None
        assert result.timed_out is True

    def test_multiline_output(self):
        """PTY streams multi-line output."""
        gen = execute_streaming(
            ["sh", "-c", "echo line1; echo line2; echo line3"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=10,
        )
        chunks: list[bytes] = []
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration:
            pass

        output = b"".join(chunks).decode("utf-8", errors="replace")
        assert "line1" in output
        assert "line2" in output
        assert "line3" in output

    def test_invalid_command(self):
        """PTY handles command not found."""
        gen = execute_streaming(
            ["nonexistent_binary_xyz"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"},
            cwd="/tmp",
            timeout=5,
        )
        chunks: list[bytes] = []
        result = None
        try:
            while True:
                chunks.append(next(gen))
        except StopIteration as e:
            result = e.value

        assert result is not None
        # Should get a non-zero exit code (127 for command not found)
        assert result.exit_code != 0
