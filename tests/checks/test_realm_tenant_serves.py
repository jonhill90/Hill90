"""Tests for scripts/checks/realm-tenant-serves-test.sh

The file-shape assertions live in test_realm_tenant_clients.py. These are the ones
that need a real Keycloak, because the claim the tenant's services read —
`resource_access.hill90-ui.roles` — is emitted by built-in client scopes this repo
does not define. Only Keycloak can answer whether it actually appears.

The script builds and destroys its own throwaway Keycloak; it never touches a
running stack.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "realm-tenant-serves-test.sh"

docker_available = shutil.which("docker") is not None and (
    subprocess.run(["docker", "info"], capture_output=True, timeout=30).returncode == 0
    if shutil.which("docker")
    else False
)


def test_script_exists():
    assert SCRIPT.is_file(), f"missing: {SCRIPT}"


@pytest.mark.skipif(not docker_available, reason="needs a reachable docker daemon")
def test_the_realm_serves_the_tenant():
    result = subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, cwd=ROOT, timeout=900
    )
    assert result.returncode == 0, (
        "the platform realm does not serve the tenant correctly:\n"
        f"{result.stdout}\n{result.stderr}"
    )
