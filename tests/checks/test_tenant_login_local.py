"""Tests for scripts/checks/tenant-login-local-test.sh

This is the only check in the suite that needs a RUNNING local platform stack, so
it skips rather than fails when there isn't one — including in CI. The realm's
shape and the claims Keycloak emits are covered without a stack by
test_realm_tenant_clients.py and test_realm_tenant_serves.py; what this adds is a
completed authorization-code login against the local platform Keycloak, with a
refusal control.

Run it locally after `bash scripts/local.sh up`.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "tenant-login-local-test.sh"


def _local_keycloak() -> str | None:
    """The local platform Keycloak container, if one is running."""
    if not shutil.which("docker"):
        return None
    env_local = ROOT / ".env.local"
    prefix = ""
    if env_local.is_file():
        for line in env_local.read_text().splitlines():
            if line.startswith("CONTAINER_PREFIX="):
                prefix = line.split("=", 1)[1].strip()
    name = f"{prefix}keycloak"
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        capture_output=True, text=True, timeout=30,
    )
    return name if r.returncode == 0 and r.stdout.strip() == "true" else None


def test_script_exists():
    assert SCRIPT.is_file(), f"missing: {SCRIPT}"


@pytest.mark.skipif(
    _local_keycloak() is None,
    reason="no local platform Keycloak running (bash scripts/local.sh up)",
)
def test_a_tenant_user_can_complete_a_login_and_a_roleless_one_is_refused():
    result = subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, cwd=ROOT, timeout=600
    )
    # The script exits 0 with a SKIP line if the stack vanished between the
    # fixture check and the run; treat that as a skip rather than a false pass.
    if "SKIP:" in result.stdout:
        pytest.skip(result.stdout.strip())
    assert result.returncode == 0, (
        "the local platform Keycloak did not serve the tenant correctly:\n"
        f"{result.stdout}\n{result.stderr}"
    )
    # Guard against a vacuous pass: the assertions must actually have run.
    assert "assertions passed" in result.stdout, result.stdout
