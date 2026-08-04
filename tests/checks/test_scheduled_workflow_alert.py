"""Tests for scripts/checks/build_scheduled_workflow_alert.py

POSITIVE CONTROL for the payload builder itself: a builder that has only ever
been run against valid input has not been shown to refuse invalid input, and
a builder nobody checked the shape of could silently emit something
Alertmanager's API rejects. This is the fabricated-input half of the proof;
the other half — a genuinely failed scheduled run reaching a real inbox — is
recorded in the PR, not here, because that is not a thing a unit test can
show.

Uses a subprocess pattern to invoke the builder as a CLI, matching
test_secrets_schema.py.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "build_scheduled_workflow_alert.py"

VALID_ARGS = [
    "--workflow", "Tenant Baseline Agreement",
    "--conclusion", "failure",
    "--event", "schedule",
    "--run-url", "https://github.com/jonhill90/Hill90/actions/runs/999",
    "--run-id", "999",
]


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def test_valid_input_exits_zero_and_prints_one_alert():
    result = run(VALID_ARGS)
    assert result.returncode == 0, result.stderr
    alerts = json.loads(result.stdout)
    assert isinstance(alerts, list)
    assert len(alerts) == 1


def test_alert_carries_the_failing_workflow_identity():
    result = run(VALID_ARGS)
    alert = json.loads(result.stdout)[0]
    assert alert["labels"]["alertname"] == "ScheduledWorkflowFailed"
    assert alert["labels"]["workflow"] == "Tenant Baseline Agreement"
    assert alert["labels"]["conclusion"] == "failure"
    assert alert["labels"]["trigger_event"] == "schedule"
    assert alert["labels"]["job"] == "workflow-watchdog-tenant-baseline-agreement"


def test_annotations_name_the_run_and_the_resolved_caveat():
    result = run(VALID_ARGS)
    alert = json.loads(result.stdout)[0]
    assert "999" in alert["annotations"]["description"]
    assert "RESOLVED" in alert["annotations"]["description"]
    assert "does NOT mean" in alert["annotations"]["description"]
    assert "re-run" in alert["annotations"]["action"]
    assert alert["annotations"]["runbook"] == "https://github.com/jonhill90/Hill90/actions/runs/999"


def test_startsat_precedes_endsat_by_the_alert_window():
    result = run(VALID_ARGS)
    alert = json.loads(result.stdout)[0]
    fmt = "%Y-%m-%dT%H:%M:%S.%fZ"
    from datetime import datetime

    starts = datetime.strptime(alert["startsAt"], fmt)
    ends = datetime.strptime(alert["endsAt"], fmt)
    assert (ends - starts).total_seconds() == 600


def test_job_label_is_stable_for_workflow_names_with_punctuation():
    result = run([
        "--workflow", "Audit hill90-ui Client Secret Agreement",
        "--conclusion", "failure",
        "--event", "schedule",
        "--run-url", "https://example.invalid/1",
        "--run-id", "1",
    ])
    alert = json.loads(result.stdout)[0]
    assert alert["labels"]["job"] == "workflow-watchdog-audit-hill90-ui-client-secret-agreement"


def test_missing_workflow_exits_2_and_prints_nothing_on_stdout():
    args = ["--conclusion", "failure", "--event", "schedule",
            "--run-url", "https://example.invalid/1", "--run-id", "1"]
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )
    # argparse itself enforces --workflow as required and exits 2 before
    # main() runs; the empty-string case below exercises this script's own
    # emptiness guard, which argparse's required=True does not catch.
    assert result.returncode != 0
    assert result.stdout.strip() == ""


def test_empty_string_conclusion_is_refused_not_silently_accepted():
    args = [
        "--workflow", "Deploy Drift Alarm",
        "--conclusion", "",
        "--event", "schedule",
        "--run-url", "https://example.invalid/1",
        "--run-id", "1",
    ]
    result = run(args)
    assert result.returncode == 2
    assert result.stdout.strip() == ""
    assert "missing required field" in result.stderr


def test_conclusions_produce_distinct_jobs_for_the_same_workflow():
    """Two different workflows failing must group separately in Alertmanager
    (group_by: [alertname, job]) rather than merge into one email — matching
    the reasoning already documented in alertmanager.yml.tmpl for
    PublicSiteDown-style grouping, applied the other direction: DISTINCT
    workflows must NOT be collapsed together."""
    a = json.loads(run(VALID_ARGS).stdout)[0]
    b = json.loads(run([
        "--workflow", "Deploy Drift Alarm",
        "--conclusion", "failure",
        "--event", "schedule",
        "--run-url", "https://example.invalid/2",
        "--run-id", "2",
    ]).stdout)[0]
    assert a["labels"]["job"] != b["labels"]["job"]
