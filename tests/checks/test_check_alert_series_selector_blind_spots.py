"""Tests for the two selector-extraction blind spots closed in check_alert_series.py
(h#855, follow-up to the cAdvisor/containerd-snapshotter diagnosis).

Both were proven against the live production Prometheus with a synthetic rule
before either fix was written (see the PR body). This is the regression form
of that same proof, run against a stubbed `docker` like
test_check_alert_series_stale_allowlist.py already does — not by importing
internals, so a refactor of the query plumbing does not silently stop testing
the actual CLI behavior.

1. A selector that is the direct argument of absent()/absent_over_time() was
   checked with the SAME "0 series = broken rule" logic as everything else.
   That is backwards: 0 series is exactly what such a selector is DESIGNED to
   detect. FixtureAbsentInversion below has 0 series for its wrapped selector
   and must still exit 0.

2. A label referenced only via by()/without()/on()/ignoring()/group_left()/
   group_right() — or only inside a `{{ $labels.x }}` annotation template —
   was invisible to selector extraction, so a rule could group by a label no
   live series of its own metric carries and still report `ok`. This is the
   historical HighMemoryUsage shape, reached through aggregation instead of
   an explicit {name="x"} matcher. FixtureGroupingHidesDeadLabel groups by a
   label ("phantom") the metric never carries, and must fail.
   FixtureGroupingHealthyLabel groups by a label ("job") the metric DOES
   carry, and must still pass — proving the fix discriminates rather than
   failing every grouping clause.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_alert_series.py"

ALERTS_YML = """\
groups:
  - name: fixture
    rules:
      - alert: FixtureAbsentInversion
        expr: absent(totally_fake_metric_h855{})
      - alert: FixtureGroupingHidesDeadLabel
        expr: sum by (phantom) (fixture_metric_h855)
      - alert: FixtureGroupingHealthyLabel
        expr: sum by (job) (fixture_metric_h855)
"""


def _series(labels_list):
    return json.dumps({
        "status": "success",
        "data": {"resultType": "vector", "result": [
            {"metric": dict(labels, __name__="fixture_metric_h855"), "value": [0, "1"]}
            for labels in labels_list
        ]},
    })


EMPTY = json.dumps({"status": "success", "data": {"resultType": "vector", "result": []}})


def _make_docker_stub(stub_dir: Path):
    """fixture_metric_h855 exists with a `job` label but never a `phantom`
    label — so a query for {phantom!=""} must return empty while {job!=""}
    and the bare metric both return real series. totally_fake_metric_h855
    never has series under any query, by construction."""
    fixture_body = _series([{"job": "fixture-job", "instance": "x"}])
    script = f"""#!/usr/bin/env bash
url="${{*: -1}}"
case "$url" in
  # The checker first probes `up` to establish that this represents live
  # Prometheus data. Every selector-specific assertion below assumes that
  # precondition, so this fixture must provide it explicitly.
  *query=up*) echo '{fixture_body}' ;;
  *totally_fake_metric_h855*) echo '{EMPTY}' ;;
  *phantom*) echo '{EMPTY}' ;;
  *fixture_metric_h855*) echo '{fixture_body}' ;;
  *) echo '{EMPTY}' ;;
esac
"""
    docker = stub_dir / "docker"
    docker.write_text(script)
    docker.chmod(docker.stat().st_mode | stat.S_IEXEC)


def run_check(tmp_path: Path):
    fake_root = tmp_path / "repo"
    (fake_root / "platform" / "observability" / "prometheus").mkdir(parents=True)
    (fake_root / "scripts" / "checks").mkdir(parents=True)
    (fake_root / "platform" / "observability" / "prometheus" / "alerts.yml").write_text(ALERTS_YML)
    (fake_root / "scripts" / "checks" / "alert-series-allowlist.txt").write_text("")
    script_copy = fake_root / "scripts" / "checks" / "check_alert_series.py"
    script_copy.write_text(SCRIPT.read_text())

    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    _make_docker_stub(stub_dir)

    env = dict(os.environ)
    env["PATH"] = f"{stub_dir}:{env['PATH']}"

    return subprocess.run(
        ["python3", "scripts/checks/check_alert_series.py"],
        cwd=fake_root, capture_output=True, text=True, env=env,
    )


class TestAbsentWrapperInversion:
    def test_zero_series_inside_absent_does_not_fail(self, tmp_path):
        result = run_check(tmp_path)
        assert "FixtureAbsentInversion" in result.stdout
        assert "this IS the rule's firing condition" in result.stdout
        missing_section = (
            result.stdout.split("SELECTOR(S) MATCH NOTHING")[1]
            if "SELECTOR(S) MATCH NOTHING" in result.stdout else ""
        )
        assert "FixtureAbsentInversion" not in missing_section


class TestGroupingLabelBlindSpot:
    def test_grouping_by_dead_label_fails(self, tmp_path):
        result = run_check(tmp_path)
        assert 'fixture_metric_h855{phantom!=""}' in result.stdout
        assert 'NO fixture_metric_h855{phantom!=""}' in result.stdout

    def test_grouping_by_live_label_passes(self, tmp_path):
        result = run_check(tmp_path)
        assert 'ok fixture_metric_h855{job!=""}' in result.stdout

    def test_overall_exit_is_1_because_of_the_dead_label_only(self, tmp_path):
        result = run_check(tmp_path)
        assert result.returncode == 1
        assert "1 SELECTOR(S) MATCH NOTHING" in result.stdout
        assert 'FixtureGroupingHidesDeadLabel: fixture_metric_h855{phantom!=""}' in result.stdout
