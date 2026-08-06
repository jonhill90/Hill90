"""Positive control for check_alert_series.py's ORIGINAL, primary hazard —
a rule whose selector matches zero live series, and is not allowlisted.

h#775 sibling-pair sweep against check_alert_counts_documented.py (which has
8 bats tests moving both sides of its comparison independently, per
tests/scripts/alert-counts-documented-control.bats). This script's own
h#841 addition (the stale-allowlist detector) has 3 direct tests in
tests/checks/test_check_alert_series_stale_allowlist.py — but the CORE
behavior this script was written for in the first place, the exact shape of
the two real bugs its own docstring cites (LokiIngestionErrors matching a
label that does not exist; HighMemoryUsage annotated with a template
variable cAdvisor never emits), had never been directly asserted anywhere:
exit code and the "cannot fire" message for an unallowlisted selector that
matches nothing. The closest existing test
(test_no_allowlist_entry_and_real_data_is_an_ordinary_pass_not_flagged)
triggers this path as an incidental side effect of a fixture rule but never
asserts the exit code or message for it — it was checking that stale-entry
detection did NOT wrongly fire, not that the ordinary failure DID correctly
fire.

Same convention as its sibling test file: runs the REAL script as a
subprocess against a stubbed `docker`, never imports internals.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_alert_series.py"


def _prom_success(series_count: int) -> str:
    result = [
        {"metric": {"__name__": "up", "instance": "x", "job": "y"}, "value": [0, "1"]}
        for _ in range(series_count)
    ]
    return json.dumps({"status": "success", "data": {"resultType": "vector", "result": result}})


def _fake_repo(tmp_path: Path, alerts_yml: str, allowlist_lines: list[str]) -> tuple[Path, Path, dict]:
    fake_root = tmp_path / "repo"
    (fake_root / "platform" / "observability" / "prometheus").mkdir(parents=True)
    (fake_root / "scripts" / "checks").mkdir(parents=True)
    (fake_root / "platform" / "observability" / "prometheus" / "alerts.yml").write_text(alerts_yml)
    (fake_root / "scripts" / "checks" / "alert-series-allowlist.txt").write_text(
        "\n".join(allowlist_lines) + "\n" if allowlist_lines else ""
    )
    (fake_root / "scripts" / "checks" / "check_alert_series.py").write_text(SCRIPT.read_text())

    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    env = dict(os.environ)
    env["PATH"] = f"{stub_dir}:{env['PATH']}"
    return fake_root, stub_dir, env


def run_check(fake_root: Path, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["python3", "scripts/checks/check_alert_series.py"],
        cwd=fake_root, capture_output=True, text=True, env=env,
    )


class TestCoreSeriesMatchHazard:
    def test_THE_ASSERTION_THAT_MATTERS_unallowlisted_selector_with_zero_series_fails_and_names_it(
        self, tmp_path
    ):
        """The exact shape of LokiIngestionErrors/HighMemoryUsage: a real
        metric name, zero matching series, no allowlist entry — must exit 1
        and report the rule as unable to fire, not pass quietly."""
        alerts_yml = """\
groups:
  - name: fixture
    rules:
      - alert: RuleThatCanNeverFire
        expr: metric_nobody_ever_emits
"""
        fake_root, stub_dir, env = _fake_repo(tmp_path, alerts_yml, [])
        docker = stub_dir / "docker"
        docker.write_text(
            "#!/usr/bin/env bash\n"
            'echo \'{"status":"success","data":{"resultType":"vector","result":[]}}\'\n'
        )
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

        result = run_check(fake_root, env)
        assert result.returncode == 1
        assert "SELECTOR(S) MATCH NOTHING" in result.stdout
        assert "RuleThatCanNeverFire" in result.stdout
        assert "metric_nobody_ever_emits" in result.stdout
        assert "this rule cannot fire" in result.stdout
        # Not mistaken for the unrelated stale-allowlist failure path.
        assert "STALE ALLOWLIST ENTRY" not in result.stdout

    def test_TWIN_the_same_selector_with_real_data_passes(self, tmp_path):
        """Same rule, same fixture shape — only the live data differs. The
        twin a positive control needs: the two runs must disagree, and only
        on the axis under test."""
        alerts_yml = """\
groups:
  - name: fixture
    rules:
      - alert: RuleThatCanFire
        expr: a_real_metric
"""
        fake_root, stub_dir, env = _fake_repo(tmp_path, alerts_yml, [])
        docker = stub_dir / "docker"
        docker.write_text(f"#!/usr/bin/env bash\necho '{_prom_success(3)}'\n")
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

        result = run_check(fake_root, env)
        assert result.returncode == 0, result.stdout
        assert "SELECTOR(S) MATCH NOTHING" not in result.stdout
        assert "every selector matches" in result.stdout

    def test_a_query_error_is_reported_distinctly_from_zero_series(self, tmp_path):
        """`docker exec` succeeding with an unparseable/rejected response is
        a DIFFERENT failure reason than a clean zero-result query — the
        script's own `missing.append((name, sel, "query error"))` vs
        `"no series"` distinction. Both currently fail the same way (exit
        1), but the printed reason must still name which one happened."""
        alerts_yml = """\
groups:
  - name: fixture
    rules:
      - alert: RuleWithBadQuery
        expr: some_metric
"""
        fake_root, stub_dir, env = _fake_repo(tmp_path, alerts_yml, [])
        docker = stub_dir / "docker"
        # The reachability probe (query=up, run once at the top of main())
        # must succeed, or this never reaches the per-selector query at all
        # — only THAT query returns unparseable JSON.
        docker.write_text(
            "#!/usr/bin/env bash\n"
            'url="${*: -1}"\n'
            'case "$url" in\n'
            f"  *query=up*) echo '{_prom_success(1)}' ;;\n"
            "  *) echo 'not json' ;;\n"
            "esac\n"
        )
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

        result = run_check(fake_root, env)
        assert result.returncode == 1
        assert "query error" in result.stdout
        assert "CANNOT REACH PROMETHEUS" not in result.stdout

    def test_prometheus_completely_unreachable_fails_rather_than_passing(self, tmp_path):
        """h#775: neither this script nor its sibling distinguishes "cannot
        determine" from a genuine finding at the exit-code level — both use
        0/1 only, unlike check_retired_roles_ungranted.py's 0/1/2 (h#727).
        Not fixed here (that is a shared shortfall against a bar set
        elsewhere, not sibling drift between this pair — see the issue).
        This test documents CURRENT behavior so a future change to it is a
        deliberate decision, not silent drift: an unreachable Prometheus
        exits 1, textually distinct via "CANNOT REACH PROMETHEUS" but not
        via exit code."""
        alerts_yml = """\
groups:
  - name: fixture
    rules:
      - alert: Irrelevant
        expr: whatever
"""
        fake_root, stub_dir, env = _fake_repo(tmp_path, alerts_yml, [])
        docker = stub_dir / "docker"
        docker.write_text("#!/usr/bin/env bash\necho 'connection refused' >&2\nexit 1\n")
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)

        result = run_check(fake_root, env)
        assert result.returncode == 1
        assert "CANNOT REACH PROMETHEUS" in result.stdout
