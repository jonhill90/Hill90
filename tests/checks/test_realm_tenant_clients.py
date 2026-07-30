"""Tests for scripts/checks/check_realm_tenant_clients.py

Invokes the checker as a CLI against mutated copies of the real realm file, the
same subprocess pattern as test_secrets_schema.py.

Each mutation is a way the tenant's authorisation has actually been at risk of
breaking silently, so a test that stops catching one of these is worth noticing.
"""

from __future__ import annotations

import copy
import json
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_realm_tenant_clients.py"
REALM = ROOT / "platform" / "auth" / "keycloak" / "platform-realm.json"


def run(realm: dict) -> subprocess.CompletedProcess:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(realm, f)
        path = f.name
    try:
        return subprocess.run(
            ["python3", str(SCRIPT), path], capture_output=True, text=True, timeout=60
        )
    finally:
        Path(path).unlink(missing_ok=True)


@pytest.fixture
def realm() -> dict:
    return json.loads(REALM.read_text())


def client(realm: dict, cid: str) -> dict:
    return next(c for c in realm["clients"] if c["clientId"] == cid)


def test_the_real_realm_file_passes():
    result = subprocess.run(
        ["python3", str(SCRIPT)], capture_output=True, text=True, cwd=ROOT, timeout=60
    )
    assert result.returncode == 0, result.stderr


def test_fails_when_the_roles_scope_is_dropped(realm):
    ui = client(realm, "hill90-ui")
    ui["defaultClientScopes"] = [s for s in ui["defaultClientScopes"] if s != "roles"]
    r = run(realm)
    assert r.returncode == 1
    assert "roles" in r.stderr and "silently" in r.stderr


def test_fails_when_default_client_scopes_are_left_implicit(realm):
    del client(realm, "hill90-ui")["defaultClientScopes"]
    r = run(realm)
    assert r.returncode == 1
    assert "defaultClientScopes" in r.stderr


@pytest.mark.parametrize(
    "claim", ["realm_access.roles", "realm_roles", "roles"]
)
def test_fails_on_any_realm_roles_mapper_whatever_the_claim(realm, claim):
    """The trap is the mapper TYPE, not the claim string it happens to carry."""
    client(realm, "hill90-ui").setdefault("protocolMappers", []).append(
        {
            "name": "realm-roles",
            "protocol": "openid-connect",
            "protocolMapper": "oidc-usermodel-realm-role-mapper",
            "config": {"claim.name": claim, "access.token.claim": "true"},
        }
    )
    r = run(realm)
    assert r.returncode == 1
    assert "realm-roles mapper" in r.stderr


def test_fails_when_the_audience_mapper_is_removed(realm):
    client(realm, "hill90-ui")["protocolMappers"] = []
    r = run(realm)
    assert r.returncode == 1
    assert "audience" in r.stderr


def test_fails_when_a_client_role_is_missing(realm):
    realm["roles"]["client"]["hill90-ui"] = [
        r for r in realm["roles"]["client"]["hill90-ui"] if r["name"] != "admin"
    ]
    r = run(realm)
    assert r.returncode == 1
    assert "hill90-ui:admin" in r.stderr


def test_fails_when_direct_access_grants_are_enabled(realm):
    client(realm, "hill90-ui")["directAccessGrantsEnabled"] = True
    r = run(realm)
    assert r.returncode == 1
    assert "directAccessGrantsEnabled" in r.stderr


def test_fails_when_the_ui_client_is_made_public(realm):
    client(realm, "hill90-ui")["publicClient"] = True
    r = run(realm)
    assert r.returncode == 1
    assert "confidential" in r.stderr


def test_fails_when_the_api_client_stops_being_bearer_only(realm):
    client(realm, "hill90-api")["bearerOnly"] = False
    r = run(realm)
    assert r.returncode == 1
    assert "bearerOnly" in r.stderr


def test_fails_when_a_tenant_client_is_absent(realm):
    realm["clients"] = [c for c in realm["clients"] if c["clientId"] != "hill90-api"]
    r = run(realm)
    assert r.returncode == 1
    assert "hill90-api" in r.stderr


# ---- do-not-clobber: the additions must not cost the platform its own client ----


def test_fails_when_hill90_vault_is_removed(realm):
    realm["clients"] = [c for c in realm["clients"] if c["clientId"] != "hill90-vault"]
    r = run(realm)
    assert r.returncode == 1
    assert "hill90-vault" in r.stderr and "OpenBao" in r.stderr


def test_fails_when_vaults_realm_roles_mapper_is_lost(realm):
    client(realm, "hill90-vault")["protocolMappers"] = []
    r = run(realm)
    assert r.returncode == 1
    assert "realm_roles" in r.stderr
