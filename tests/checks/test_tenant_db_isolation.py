"""Tests for scripts/checks/tenant-db-isolation-test.sh

The assertions themselves live in the shell script, because they have to be made
over a docker network from a second container — an in-container `psql` would
authenticate by trust and prove nothing about a role's password. This wrapper
exists so `make test` runs them.

The script builds and destroys its own throwaway Postgres. It never touches a
running stack.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "tenant-db-isolation-test.sh"

docker_available = shutil.which("docker") is not None and (
    subprocess.run(
        ["docker", "info"], capture_output=True, timeout=30
    ).returncode
    == 0
    if shutil.which("docker")
    else False
)


def test_script_exists():
    assert SCRIPT.is_file(), f"missing: {SCRIPT}"


def echo_phase_timing(stdout: str, capsys) -> None:
    """Surface the script's phase timing even when the test PASSES.

    pytest captures stdout for passing tests, so without this the timing is visible
    only when something already failed — useless for the case it exists for: a run
    that is 5x slower than usual and still green. capsys.disabled() writes straight
    to the terminal, so CI logs it on every run.
    """
    lines = stdout.splitlines()
    for i, line in enumerate(lines):
        if "Phase timing" in line:
            with capsys.disabled():
                print(f"\n    [{SCRIPT.name}]")
                # Stop at the blank line that closes the block, so the pass/fail
                # summary underneath it is not dragged in.
                for out in lines[i + 1 :]:
                    if not out.strip():
                        break
                    print(f"    {out}")
            return


@pytest.mark.skipif(
    not docker_available, reason="needs a reachable docker daemon"
)
def test_tenant_privilege_boundary_holds(capsys):
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=600,
    )
    echo_phase_timing(result.stdout, capsys)
    assert result.returncode == 0, (
        "tenant isolation assertions failed:\n"
        f"{result.stdout}\n{result.stderr}"
    )
