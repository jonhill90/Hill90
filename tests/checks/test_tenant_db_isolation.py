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


@pytest.mark.skipif(
    not docker_available, reason="needs a reachable docker daemon"
)
def test_tenant_privilege_boundary_holds():
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=600,
    )
    assert result.returncode == 0, (
        "tenant isolation assertions failed:\n"
        f"{result.stdout}\n{result.stderr}"
    )
