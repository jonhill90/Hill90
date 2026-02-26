"""Tests for scripts/checks/check_secrets_schema.py

Validates vault/SOPS/compose schema consistency checker.
Uses subprocess pattern consistent with test_check_plan_closed_loop.py.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_secrets_schema.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MINIMAL_SCHEMA = """\
excluded_vars:
  - VERSION

runtime_secrets:
  - key: DB_USER
    vault_path: secret/shared/database
    compose_refs:
      - docker-compose.db.yml
  - key: DB_PASSWORD
    vault_path: secret/shared/database
    compose_refs:
      - docker-compose.db.yml

bootstrap_secrets:
  - VPS_HOST

vault_management_secrets:
  - OPENBAO_UNSEAL_KEY

vault_approle_services:
  - db
"""

MINIMAL_COMPOSE = """\
version: '3.9'
services:
  postgres:
    image: postgres:16
    environment:
      - POSTGRES_USER=${DB_USER}
      - POSTGRES_PASSWORD=${DB_PASSWORD}
"""

MINIMAL_SOPS_EXAMPLE = """\
DB_USER=hill90
DB_PASSWORD=secret
VPS_HOST=hill90-vps
OPENBAO_UNSEAL_KEY=abc123
VAULT_DB_ROLE_ID=role-id
VAULT_DB_SECRET_ID=secret-id
"""


def _run(
    schema: str = MINIMAL_SCHEMA,
    compose: str | dict[str, str] | None = None,
    sops_example: str = MINIMAL_SOPS_EXAMPLE,
    env_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run the check script with controlled fixtures."""
    env = os.environ.copy()
    env.pop("SECRETS_SCHEMA_STRICT", None)
    env.pop("_SCHEMA_PATH_OVERRIDE", None)
    env.pop("_COMPOSE_DIR_OVERRIDE", None)
    env.pop("_SOPS_EXAMPLE_OVERRIDE", None)
    env.pop("GITHUB_STEP_SUMMARY", None)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)

        # Write schema
        schema_path = tmpdir_path / "secrets-schema.yaml"
        schema_path.write_text(schema, encoding="utf-8")
        env["_SCHEMA_PATH_OVERRIDE"] = str(schema_path)

        # Write compose file(s)
        compose_dir = tmpdir_path / "compose"
        compose_dir.mkdir()
        if compose is None:
            (compose_dir / "docker-compose.db.yml").write_text(
                MINIMAL_COMPOSE, encoding="utf-8"
            )
        elif isinstance(compose, str):
            (compose_dir / "docker-compose.db.yml").write_text(
                compose, encoding="utf-8"
            )
        elif isinstance(compose, dict):
            for name, content in compose.items():
                (compose_dir / name).write_text(content, encoding="utf-8")
        env["_COMPOSE_DIR_OVERRIDE"] = str(compose_dir)

        # Write SOPS example
        sops_path = tmpdir_path / "prod.enc.env.example"
        sops_path.write_text(sops_example, encoding="utf-8")
        env["_SOPS_EXAMPLE_OVERRIDE"] = str(sops_path)

        # Summary
        summary_path = tmpdir_path / "summary.md"
        env["GITHUB_STEP_SUMMARY"] = str(summary_path)

        if env_overrides:
            env.update(env_overrides)

        return subprocess.run(
            ["python3", str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            cwd=ROOT,
        )


# ---------------------------------------------------------------------------
# T1: Schema YAML loads correctly
# ---------------------------------------------------------------------------


class TestSchemaLoads:
    def test_schema_loads(self):
        """Valid schema YAML should load without error."""
        result = _run()
        assert result.returncode == 0

    def test_real_schema_loads(self):
        """The actual secrets-schema.yaml should load without error."""
        import yaml

        schema_path = ROOT / "platform" / "vault" / "secrets-schema.yaml"
        with open(schema_path, encoding="utf-8") as f:
            schema = yaml.safe_load(f)
        assert "runtime_secrets" in schema
        assert "bootstrap_secrets" in schema
        assert "vault_management_secrets" in schema
        assert "vault_approle_services" in schema


# ---------------------------------------------------------------------------
# T2: Current state passes validation
# ---------------------------------------------------------------------------


class TestCurrentStatePasses:
    def test_current_state_passes(self):
        """Running the validator against the real codebase should pass."""
        env = os.environ.copy()
        env.pop("SECRETS_SCHEMA_STRICT", None)
        env.pop("GITHUB_STEP_SUMMARY", None)
        result = subprocess.run(
            ["python3", str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            cwd=ROOT,
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout


# ---------------------------------------------------------------------------
# T3: Missing compose ref detected
# ---------------------------------------------------------------------------


class TestMissingComposeRef:
    def test_missing_compose_ref_detected(self):
        """A ${VAR} in compose not in schema should produce a warning."""
        compose_with_extra = MINIMAL_COMPOSE + "      - EXTRA_KEY=${UNKNOWN_SECRET}\n"
        result = _run(compose=compose_with_extra)
        assert "[WARN]" in result.stdout
        assert "UNKNOWN_SECRET" in result.stdout


# ---------------------------------------------------------------------------
# T4: Unknown SOPS key detected
# ---------------------------------------------------------------------------


class TestUnknownSopsKey:
    def test_unknown_sops_key_detected(self):
        """A SOPS key not in any schema category should produce a warning."""
        sops_with_extra = MINIMAL_SOPS_EXAMPLE + "MYSTERY_KEY=value\n"
        result = _run(sops_example=sops_with_extra)
        assert "[WARN]" in result.stdout
        assert "MYSTERY_KEY" in result.stdout


# ---------------------------------------------------------------------------
# T5: Duplicate key without dedup warns
# ---------------------------------------------------------------------------


class TestDuplicateKeyWarns:
    def test_duplicate_key_warns(self):
        """A key in multiple vault paths without dedup should warn."""
        schema = """\
excluded_vars: []
runtime_secrets:
  - key: SHARED_KEY
    vault_path: secret/a/config
    compose_refs: []
  - key: SHARED_KEY
    vault_path: secret/b/config
    compose_refs: []
bootstrap_secrets: []
vault_management_secrets: []
vault_approle_services: []
"""
        compose = "version: '3.9'\nservices: {}\n"
        sops = "SHARED_KEY=val\n"
        result = _run(schema=schema, compose=compose, sops_example=sops)
        assert "[WARN]" in result.stdout
        assert "SHARED_KEY" in result.stdout
        assert "dedup" in result.stdout.lower()


# ---------------------------------------------------------------------------
# T6: Strict mode exits 1 on violations
# ---------------------------------------------------------------------------


class TestStrictMode:
    def test_strict_mode_fails(self):
        """SECRETS_SCHEMA_STRICT=1 should exit 1 when warnings exist."""
        sops_with_extra = MINIMAL_SOPS_EXAMPLE + "MYSTERY_KEY=value\n"
        result = _run(
            sops_example=sops_with_extra,
            env_overrides={"SECRETS_SCHEMA_STRICT": "1"},
        )
        assert result.returncode == 1
        assert "Strict mode" in result.stdout


# ---------------------------------------------------------------------------
# T7: Advisory mode exits 0 with warnings
# ---------------------------------------------------------------------------


class TestAdvisoryMode:
    def test_advisory_mode_passes(self):
        """Default advisory mode should exit 0 even with warnings."""
        sops_with_extra = MINIMAL_SOPS_EXAMPLE + "MYSTERY_KEY=value\n"
        result = _run(sops_example=sops_with_extra)
        assert result.returncode == 0
        assert "[WARN]" in result.stdout


# ---------------------------------------------------------------------------
# Additional edge cases
# ---------------------------------------------------------------------------


class TestComposeRefsMismatch:
    def test_schema_declares_compose_ref_not_found(self):
        """Schema declares a compose_ref that doesn't exist in compose files."""
        schema = """\
excluded_vars: []
runtime_secrets:
  - key: DB_USER
    vault_path: secret/shared/database
    compose_refs:
      - docker-compose.db.yml
      - docker-compose.api.yml
bootstrap_secrets: []
vault_management_secrets: []
vault_approle_services: []
"""
        result = _run(schema=schema, sops_example="DB_USER=x\n")
        assert "[WARN]" in result.stdout
        assert "docker-compose.api.yml" in result.stdout

    def test_compose_ref_not_declared_in_schema(self):
        """Compose has ${VAR} but schema doesn't list that compose file."""
        schema = """\
excluded_vars: []
runtime_secrets:
  - key: DB_USER
    vault_path: secret/shared/database
    compose_refs: []
bootstrap_secrets: []
vault_management_secrets: []
vault_approle_services: []
"""
        result = _run(schema=schema, sops_example="DB_USER=x\n")
        assert "[WARN]" in result.stdout
        assert "docker-compose.db.yml" in result.stdout


class TestGithubStepSummary:
    def test_summary_written(self):
        """GITHUB_STEP_SUMMARY should be written to."""
        with tempfile.TemporaryDirectory() as tmpdir:
            summary = Path(tmpdir) / "summary.md"
            result = _run(env_overrides={"GITHUB_STEP_SUMMARY": str(summary)})
            assert result.returncode == 0
            assert summary.exists()
            content = summary.read_text(encoding="utf-8")
            assert "Secrets Schema" in content
