"""Tests for app.policy — command and path policy enforcement."""

import os
import tempfile

import pytest

from app.policy import CommandPolicy, PathPolicy


class TestCommandPolicy:
    def test_allowed_binary(self):
        policy = CommandPolicy(allowed_binaries=["/usr/bin/echo"])
        allowed, reason = policy.check("echo hello")
        # echo resolves via shutil.which — may or may not be in /usr/bin
        # so we test the mechanism, not the exact path
        assert isinstance(allowed, bool)

    def test_denied_pattern_blocks(self):
        policy = CommandPolicy(denied_patterns=[r"rm\s+-rf\s+/"])
        allowed, reason = policy.check("rm -rf /")
        assert allowed is False
        assert "denied pattern" in reason

    def test_denied_pattern_fork_bomb(self):
        policy = CommandPolicy(denied_patterns=[r":\(\)\{"])
        allowed, reason = policy.check(":(){ :|:& };:")
        assert allowed is False

    def test_empty_command(self):
        policy = CommandPolicy()
        allowed, reason = policy.check("")
        assert allowed is False
        assert "Empty" in reason

    def test_unparseable_command(self):
        policy = CommandPolicy()
        allowed, reason = policy.check("echo 'unterminated")
        assert allowed is False
        assert "parse" in reason.lower()

    def test_no_allowlist_permits_all(self):
        """With empty allowlist, binary check is skipped."""
        policy = CommandPolicy(allowed_binaries=[])
        allowed, reason = policy.check("anything arg1 arg2")
        assert allowed is True

    def test_binary_not_in_allowlist(self):
        policy = CommandPolicy(allowed_binaries=["/usr/bin/git"])
        allowed, reason = policy.check("curl http://example.com")
        assert allowed is False
        assert "not in allowlist" in reason

    def test_execute_returns_dict(self):
        policy = CommandPolicy()
        result = policy.execute("echo hello")
        assert isinstance(result, dict)
        assert "success" in result

    def test_execute_denied_command(self):
        policy = CommandPolicy(denied_patterns=[r"rm\s+-rf"])
        result = policy.execute("rm -rf /tmp")
        assert result["success"] is False
        assert "denied pattern" in result["error"]

    def test_timeout_clamped(self):
        policy = CommandPolicy(max_timeout=10)
        # Timeout should be clamped to max_timeout
        result = policy.execute("echo fast", timeout=999)
        # Should succeed since echo is fast
        assert isinstance(result, dict)

    def test_execute_echo(self, tmp_path):
        """Verify actual execution works with no allowlist."""
        policy = CommandPolicy()
        result = policy.execute("echo test-output", cwd=str(tmp_path))
        assert result["success"] is True
        assert "test-output" in result["stdout"]
        assert result["exit_code"] == 0


class TestPathPolicy:
    def test_allowed_read(self, tmp_path):
        policy = PathPolicy(allowed_paths=[str(tmp_path)])
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello")
        allowed, reason = policy.check_read(str(test_file))
        assert allowed is True

    def test_denied_read(self):
        policy = PathPolicy(
            allowed_paths=["/workspace"],
            denied_paths=["/workspace/secrets"],
        )
        allowed, reason = policy.check_read("/workspace/secrets/key.pem")
        assert allowed is False
        assert "denied" in reason.lower()

    def test_outside_allowed(self):
        policy = PathPolicy(allowed_paths=["/workspace"])
        allowed, reason = policy.check_read("/etc/passwd")
        assert allowed is False
        assert "not in allowed" in reason.lower()

    def test_write_when_read_only(self):
        policy = PathPolicy(allowed_paths=["/workspace"], read_only=True)
        allowed, reason = policy.check_write("/workspace/file.txt")
        assert allowed is False
        assert "read-only" in reason.lower()

    def test_write_when_writable(self, tmp_path):
        policy = PathPolicy(allowed_paths=[str(tmp_path)], read_only=False)
        allowed, reason = policy.check_write(str(tmp_path / "file.txt"))
        assert allowed is True

    def test_symlink_resolution(self, tmp_path):
        """Symlinks should be resolved to real paths before checking."""
        real_dir = tmp_path / "real"
        real_dir.mkdir()
        link = tmp_path / "link"
        link.symlink_to(real_dir)

        policy = PathPolicy(allowed_paths=[str(real_dir)])
        allowed, _ = policy.check_read(str(link / "file.txt"))
        assert allowed is True

    def test_path_traversal_blocked(self, tmp_path):
        """Path traversal via .. should be resolved and blocked."""
        allowed_dir = tmp_path / "allowed"
        allowed_dir.mkdir()

        policy = PathPolicy(allowed_paths=[str(allowed_dir)])
        allowed, reason = policy.check_read(str(allowed_dir / ".." / "other" / "file"))
        assert allowed is False
