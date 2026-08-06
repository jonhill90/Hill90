"""Tests for scripts/checks/check_shared_secret_agrees.py (Hill90#839).

Two layers, deliberately separate:

1. `secrets_agree` — the pure comparison — tested directly, no SOPS involved.
   This is where the "never a pass on empty" rule lives, and it is the rule
   most likely to erode under a future edit, so it gets the fastest tests.

2. The CLI, invoked as a subprocess against REAL sops-encrypted fixture
   files, built here with a throwaway, freshly generated age key — never a
   production key, never a production secret. This is the positive control
   the issue asked for: a genuinely divergent pair, decrypted for real,
   must exit 1 — not "the script can parse two files", which proves nothing
   about the comparison actually catching a rotation that only touched one
   side.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_shared_secret_agrees.py"

sys_path_insert = str(ROOT / "scripts" / "checks")
import sys
if sys_path_insert not in sys.path:
    sys.path.insert(0, sys_path_insert)
from check_shared_secret_agrees import secrets_agree, hash_secret  # noqa: E402

SOPS_AVAILABLE = shutil.which("sops") is not None and shutil.which("age-keygen") is not None


# --------------------------------------------------------------- pure logic ---

class TestSecretsAgree:
    def test_identical_nonempty_values_agree(self):
        assert secrets_agree("hunter2-rotated", "hunter2-rotated") is True

    def test_different_nonempty_values_do_not_agree(self):
        assert secrets_agree("hunter2-old", "hunter2-new") is False

    def test_both_empty_is_not_agreement(self):
        # Two nothings are not the same as one confirmed shared value.
        assert secrets_agree("", "") is False

    def test_one_empty_is_not_agreement(self):
        assert secrets_agree("hunter2", "") is False
        assert secrets_agree("", "hunter2") is False

    def test_hash_is_deterministic_and_not_the_plaintext(self):
        h = hash_secret("hunter2")
        assert h == hash_secret("hunter2")
        assert "hunter2" not in h
        assert len(h) == 64  # sha256 hex digest


# ------------------------------------------------------- end-to-end, real sops ---

@pytest.fixture
def sops_fixture(tmp_path):
    """A throwaway age keypair and two tiny sops-encrypted .env files, one
    per 'repository'. Nothing here touches a real key or a real secret."""
    if not SOPS_AVAILABLE:
        pytest.skip("sops/age-keygen not installed")

    key_file = tmp_path / "test-key.txt"
    subprocess.run(["age-keygen", "-o", str(key_file)], check=True, capture_output=True)
    pubkey_line = [
        line for line in key_file.read_text().splitlines()
        if line.startswith("# public key:")
    ][0]
    pubkey = pubkey_line.split(":", 1)[1].strip()

    sops_config = tmp_path / ".sops.yaml"
    sops_config.write_text(
        f"creation_rules:\n  - path_regex: .*\\.enc\\.env$\n    age: {pubkey}\n"
    )

    def make_store(name: str, key: str, value: str) -> Path:
        # sops matches creation_rules against the file's own path, so the
        # target must already be named *.enc.env before encrypting in place —
        # a separate *.plain.env source would never match the regex above.
        enc = tmp_path / f"{name}.enc.env"
        enc.write_text(f"{key}={value}\n")
        subprocess.run(
            ["sops", "--config", str(sops_config), "-e", "-i", str(enc)],
            check=True, capture_output=True, text=True,
            env={"SOPS_AGE_KEY_FILE": str(key_file), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
        )
        return enc

    yield key_file, make_store


def run_check(key_file: Path, this_file: Path, this_key: str, other_file: Path, other_key: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "python3", str(SCRIPT),
            "--label", "testuser01",
            "--this-file", str(this_file), "--this-key", this_key,
            "--other-file", str(other_file), "--other-key", other_key,
        ],
        capture_output=True, text=True,
        env={"SOPS_AGE_KEY_FILE": str(key_file), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
    )


class TestCLIEndToEnd:
    def test_agreeing_stores_exit_0(self, sops_fixture):
        key_file, make_store = sops_fixture
        this_file = make_store("this-repo", "TEST_USER_PASSWORD", "shared-value-abc123")
        other_file = make_store("other-repo", "TESTUSER01_PASSWORD", "shared-value-abc123")

        result = run_check(key_file, this_file, "TEST_USER_PASSWORD", other_file, "TESTUSER01_PASSWORD")
        assert result.returncode == 0, result.stderr
        assert "agrees across repositories" in result.stdout
        # Never the raw value anywhere in output.
        assert "shared-value-abc123" not in result.stdout
        assert "shared-value-abc123" not in result.stderr

    def test_POSITIVE_CONTROL_a_genuinely_diverged_pair_exits_1(self, sops_fixture):
        # The exact scenario hill90-app#588 produced: one side rotated, the
        # other left stale. Both files decrypt cleanly — this is not a
        # cannot-read case, it's a real, decryptable disagreement.
        key_file, make_store = sops_fixture
        this_file = make_store("this-repo", "TEST_USER_PASSWORD", "old-password-before-rotation")
        other_file = make_store("other-repo", "TESTUSER01_PASSWORD", "new-password-after-588-rotated-only-here")

        result = run_check(key_file, this_file, "TEST_USER_PASSWORD", other_file, "TESTUSER01_PASSWORD")
        assert result.returncode == 1
        assert "DIVERGED" in result.stderr
        assert "Hill90#839" in result.stderr
        # Still never the raw values, even in the failure message.
        assert "old-password-before-rotation" not in result.stderr
        assert "new-password-after-588-rotated-only-here" not in result.stderr

    def test_missing_other_file_exits_2_not_a_pass(self, sops_fixture):
        key_file, make_store = sops_fixture
        this_file = make_store("this-repo", "TEST_USER_PASSWORD", "some-value")
        missing = this_file.parent / "does-not-exist.enc.env"

        result = run_check(key_file, this_file, "TEST_USER_PASSWORD", missing, "TESTUSER01_PASSWORD")
        assert result.returncode == 2
        assert "CANNOT COMPARE" in result.stderr
        assert "does not exist" in result.stderr

    def test_wrong_key_name_on_one_side_exits_2_not_a_pass(self, sops_fixture):
        # A store that decrypts fine but does not carry the requested key —
        # sops --extract fails distinctly from a missing file, and this must
        # not be conflated with agreement either.
        key_file, make_store = sops_fixture
        this_file = make_store("this-repo", "TEST_USER_PASSWORD", "some-value")
        other_file = make_store("other-repo", "SOME_OTHER_KEY", "unrelated")

        result = run_check(key_file, this_file, "TEST_USER_PASSWORD", other_file, "TESTUSER01_PASSWORD")
        assert result.returncode == 2
        assert "CANNOT COMPARE" in result.stderr

    def test_wrong_decryption_key_exits_2_not_a_pass(self, sops_fixture, tmp_path):
        # A check that cannot decrypt one side because of a key mismatch —
        # not a missing file — must fail exactly the same way: loudly, never
        # silently treated as agreement.
        key_file, make_store = sops_fixture
        this_file = make_store("this-repo", "TEST_USER_PASSWORD", "some-value")
        other_file = make_store("other-repo", "TESTUSER01_PASSWORD", "some-value")

        wrong_key_file = tmp_path / "wrong-key.txt"
        subprocess.run(["age-keygen", "-o", str(wrong_key_file)], check=True, capture_output=True)

        result = subprocess.run(
            [
                "python3", str(SCRIPT),
                "--label", "testuser01",
                "--this-file", str(this_file), "--this-key", "TEST_USER_PASSWORD",
                "--other-file", str(other_file), "--other-key", "TESTUSER01_PASSWORD",
            ],
            capture_output=True, text=True,
            env={"SOPS_AGE_KEY_FILE": str(wrong_key_file), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
        )
        assert result.returncode == 2
        assert "CANNOT COMPARE" in result.stderr
