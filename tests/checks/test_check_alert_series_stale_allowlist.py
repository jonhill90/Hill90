"""Tests for the stale-allowlist detection in check_alert_series.py (h#841).

h#839 added an allowlist entry for the shared-secret-agreement heartbeat
metric, correct when written since the workflow had never run. Dispatching
it once made the entry wrong within the hour, and nothing said so — the
script silently took the "ok, matches live data" branch and never compared
that against the allowlist also declaring the same selector absent.

This exercises the REAL script as a subprocess against a stubbed `docker`,
the same convention this repo's other check tests use (test_secrets_schema.py,
test_realm_tenant_clients.py) — not by importing internals, so a refactor of
prometheus_query's plumbing does not silently stop testing the actual CLI
behavior.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_alert_series.py"

ALERTS_YML = """\
groups:
  - name: fixture
    rules:
      - alert: FixtureRuleWithData
        expr: up
      - alert: FixtureRuleWithNoData
        expr: hill90_e2e_delivery_test
"""


def _prom_response(series_count: int) -> str:
    result = [
        {"metric": {"__name__": "up", "instance": "x", "job": "y"}, "value": [0, "1"]}
        for _ in range(series_count)
    ]
    return json.dumps({"status": "success", "data": {"resultType": "vector", "result": result}})


def _make_docker_stub(stub_dir: Path, with_data_for_up: bool, no_data_for_e2e: bool = True):
    """A `docker exec prometheus wget -qO- <url>` stub. Routes on the query
    string embedded in the URL — good enough for the two fixture selectors
    above, and never touches a real Prometheus."""
    up_body = _prom_response(15) if with_data_for_up else _prom_response(0)
    e2e_body = _prom_response(0) if no_data_for_e2e else _prom_response(1)
    script = f"""#!/usr/bin/env bash
url="${{*: -1}}"
case "$url" in
  *query=up*) echo '{up_body}' ;;
  *hill90_e2e_delivery_test*) echo '{e2e_body}' ;;
  *) echo '{{"status":"success","data":{{"resultType":"vector","result":[]}}}}' ;;
esac
"""
    docker = stub_dir / "docker"
    docker.write_text(script)
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)


def run_check(tmp_path: Path, allowlist_lines: list[str]) -> subprocess.CompletedProcess:
    fake_root = tmp_path / "repo"
    (fake_root / "platform" / "observability" / "prometheus").mkdir(parents=True)
    (fake_root / "scripts" / "checks").mkdir(parents=True)
    (fake_root / "platform" / "observability" / "prometheus" / "alerts.yml").write_text(ALERTS_YML)
    (fake_root / "scripts" / "checks" / "alert-series-allowlist.txt").write_text(
        "\n".join(allowlist_lines) + "\n" if allowlist_lines else ""
    )
    script_copy = fake_root / "scripts" / "checks" / "check_alert_series.py"
    script_copy.write_text(SCRIPT.read_text())

    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()

    env = dict(os.environ)
    env["PATH"] = f"{stub_dir}:{env['PATH']}"

    return fake_root, stub_dir, env


class TestStaleAllowlistDetection:
    def test_allowlisted_selector_with_real_data_fails_as_stale(self, tmp_path):
        fake_root, stub_dir, env = run_check(
            tmp_path,
            ["up  # DELIBERATELY WRONG for this test — up always has data."],
        )
        _make_docker_stub(stub_dir, with_data_for_up=True)
        # Only the `up` rule — an unrelated missing selector would return 1
        # for its OWN reason first and this test is not about that path.
        (fake_root / "platform" / "observability" / "prometheus" / "alerts.yml").write_text(
            """\
groups:
  - name: fixture
    rules:
      - alert: FixtureRuleWithData
        expr: up
"""
        )

        result = subprocess.run(
            ["python3", "scripts/checks/check_alert_series.py"],
            cwd=fake_root, capture_output=True, text=True, env=env,
        )
        assert result.returncode == 1
        assert "STALE ALLOWLIST ENTRY" in result.stdout
        assert "up is listed" in result.stdout
        assert "1 STALE ALLOWLIST ENTRY" in result.stdout

    def test_allowlisted_selector_genuinely_absent_still_passes(self, tmp_path):
        # TWIN of the test above: the allowlist entry for the selector that
        # really IS absent must not be flagged — this proves the new check
        # is discriminating (matches -> stale) and not just failing on any
        # allowlist entry existing at all.
        fake_root, stub_dir, env = run_check(
            tmp_path,
            [
                "up  # not exercised in this test",
                "hill90_e2e_delivery_test  # genuinely absent outside a test run",
            ],
        )
        _make_docker_stub(stub_dir, with_data_for_up=True, no_data_for_e2e=True)

        # Remove the `up` fixture rule's data too, so ONLY the e2e allowlist
        # entry is exercised as "declared absent, and it genuinely is".
        (fake_root / "platform" / "observability" / "prometheus" / "alerts.yml").write_text(
            """\
groups:
  - name: fixture
    rules:
      - alert: FixtureRuleWithNoData
        expr: hill90_e2e_delivery_test
"""
        )

        result = subprocess.run(
            ["python3", "scripts/checks/check_alert_series.py"],
            cwd=fake_root, capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0, result.stdout
        assert "STALE ALLOWLIST ENTRY" not in result.stdout
        assert "declared absent" in result.stdout

    def test_no_allowlist_entry_and_real_data_is_an_ordinary_pass_not_flagged(self, tmp_path):
        fake_root, stub_dir, env = run_check(tmp_path, [])
        _make_docker_stub(stub_dir, with_data_for_up=True)

        result = subprocess.run(
            ["python3", "scripts/checks/check_alert_series.py"],
            cwd=fake_root, capture_output=True, text=True, env=env,
        )
        # hill90_e2e_delivery_test has no data and no allowlist entry here,
        # so this run is expected to fail on THAT — but never on a stale
        # allowlist entry, since none exists.
        assert "STALE ALLOWLIST ENTRY" not in result.stdout
