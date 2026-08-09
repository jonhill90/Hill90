"""Regression test for #775: a live check must not vacuously pass no alerts.

Prometheus accepts recording rules, but this checker deliberately inspects alert
rules only. A recording-rule-only file must therefore fail even when the
Prometheus connectivity probe has a real ``up`` series.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_alert_series.py"


def test_recording_rule_only_file_refuses_vacuous_success(tmp_path: Path):
    fake_root = tmp_path / "repo"
    rules_dir = fake_root / "platform" / "observability" / "prometheus"
    checks_dir = fake_root / "scripts" / "checks"
    rules_dir.mkdir(parents=True)
    checks_dir.mkdir(parents=True)
    (rules_dir / "alerts.yml").write_text(
        """\
groups:
  - name: fixture
    rules:
      - record: fixture_recording_rule_775
        expr: vector(1)
"""
    )
    (checks_dir / "alert-series-allowlist.txt").write_text("")
    (checks_dir / "check_alert_series.py").write_text(SCRIPT.read_text())

    up_response = json.dumps({
        "status": "success",
        "data": {"resultType": "vector", "result": [{
            "metric": {"__name__": "up", "job": "prometheus"},
            "value": [0, "1"],
        }]},
    })
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    docker = stub_dir / "docker"
    docker.write_text(f"""#!/usr/bin/env bash
case "${{*: -1}}" in
  *query=up*) echo '{up_response}' ;;
  *) echo '{{"status":"success","data":{{"resultType":"vector","result":[]}}}}' ;;
esac
""")
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

    env = dict(os.environ)
    env["PATH"] = f"{stub_dir}:{env['PATH']}"
    result = subprocess.run(
        ["python3", "scripts/checks/check_alert_series.py"],
        cwd=fake_root, capture_output=True, text=True, env=env,
    )

    assert result.returncode == 1, result.stdout
    assert "rules file contains no alert rules" in result.stdout
    assert "0 selectors checked" not in result.stdout


def test_empty_successful_up_probe_refuses_vacuous_success(tmp_path: Path):
    """A reachable Prometheus with no live series is not a healthy proof.

    ``absent()`` correctly permits its *selector* to have no series, but that
    exception must not turn an empty successful ``up`` probe into a green live
    check.  Before #867's follow-up guard, this fixture printed the
    absent-wrapper exception and exited 0.
    """
    fake_root = tmp_path / "repo"
    rules_dir = fake_root / "platform" / "observability" / "prometheus"
    checks_dir = fake_root / "scripts" / "checks"
    rules_dir.mkdir(parents=True)
    checks_dir.mkdir(parents=True)
    (rules_dir / "alerts.yml").write_text(
        """\
groups:
  - name: fixture
    rules:
      - alert: FixtureAbsent
        expr: absent(fixture_metric_867)
"""
    )
    (checks_dir / "alert-series-allowlist.txt").write_text("")
    (checks_dir / "check_alert_series.py").write_text(SCRIPT.read_text())

    empty_response = json.dumps({
        "status": "success",
        "data": {"resultType": "vector", "result": []},
    })
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    docker = stub_dir / "docker"
    docker.write_text(f"""#!/usr/bin/env bash
echo '{empty_response}'
""")
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

    env = dict(os.environ)
    env["PATH"] = f"{stub_dir}:{env['PATH']}"
    result = subprocess.run(
        ["python3", "scripts/checks/check_alert_series.py"],
        cwd=fake_root, capture_output=True, text=True, env=env,
    )

    assert result.returncode == 1, result.stdout
    assert "up query returned no live series" in result.stdout
