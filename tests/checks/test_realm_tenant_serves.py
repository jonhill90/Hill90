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


def echo_phase_timing(stdout: str, capsys) -> None:
    """Surface the script's phase timing even when the test PASSES.

    pytest captures stdout for passing tests, so without this the timing is visible
    only when something already failed — which is useless for the case it exists for:
    a run that is 5x slower than usual and still green. capsys.disabled() writes
    straight to the terminal, so CI logs it on every run.
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


@pytest.mark.skipif(not docker_available, reason="needs a reachable docker daemon")
def test_the_realm_serves_the_tenant(capsys):
    result = subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, cwd=ROOT, timeout=900
    )
    echo_phase_timing(result.stdout, capsys)
    assert result.returncode == 0, (
        "the platform realm does not serve the tenant correctly:\n"
        f"{result.stdout}\n{result.stderr}"
    )
