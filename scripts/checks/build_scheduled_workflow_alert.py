#!/usr/bin/env python3
"""Build an Alertmanager v2 alert payload for a scheduled workflow that did
not succeed.

    python3 scripts/checks/build_scheduled_workflow_alert.py \\
        --workflow "Tenant Baseline Agreement" \\
        --conclusion failure \\
        --event schedule \\
        --run-url https://github.com/jonhill90/Hill90/actions/runs/123 \\
        --run-id 123

Prints the JSON array body for `POST /api/v2/alerts` on stdout. Never touches
the network — the caller (scheduled-checks-watchdog.yml) `docker cp`'s this
into the alertmanager container and posts it with `docker exec ... wget`,
from inside that container's own network namespace, over the same
SSH+Tailscale path deploy-drift and the hill90-ui secret audit already use to
reach the VPS. Alertmanager gains no new listener for this: see the
"DELIBERATELY NOT PUBLIC" comment on the alertmanager service in
deploy/compose/prod/docker-compose.observability.yml — it publishes no host
port and has no auth of its own, so it stays reachable only from its own
Docker network, exactly as it already was.

WHY startsAt AND endsAt ARE BOTH SET. Left unset, Alertmanager treats an alert
as "still firing" until resolve_timeout (5m) passes with no refresh — an
implicit behaviour nobody configured for this purpose. This watcher posts once
per failed run and never posts again for that run, so an explicit endsAt makes
the auto-resolve a stated fact instead of a side effect of a timeout. The
RESOLVED email that follows is expected; the annotation text says so, because
"RESOLVED" here means "this notification's window closed," not "the workflow
started passing."

Exit codes:
  0  payload printed to stdout
  2  a required field was empty — refuses to print a malformed alert
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys

ALERT_WINDOW = datetime.timedelta(minutes=10)


def _job_label(workflow: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in workflow.lower()).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return f"workflow-watchdog-{slug}"


def build(
    *,
    workflow: str,
    conclusion: str,
    event: str,
    run_url: str,
    run_id: str,
    now: datetime.datetime,
) -> list[dict]:
    starts = now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    ends = (now + ALERT_WINDOW).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    return [
        {
            "labels": {
                "alertname": "ScheduledWorkflowFailed",
                "job": _job_label(workflow),
                "workflow": workflow,
                "conclusion": conclusion,
                "trigger_event": event,
                "severity": "warning",
                "instance": "github-actions",
            },
            "annotations": {
                "summary": f"Scheduled workflow '{workflow}' did not succeed ({conclusion}).",
                "description": (
                    f"The '{workflow}' GitHub Actions workflow completed with "
                    f"conclusion '{conclusion}' (triggered by '{event}', run "
                    f"{run_id}). This is a point-in-time report of one completed "
                    "run, posted by scheduled-checks-watchdog.yml, which fires on "
                    "the workflow_run completion event rather than its own "
                    "schedule and never re-calls the GitHub API or re-runs the "
                    "workflow it reports on. The RESOLVED email that follows in "
                    "a few minutes is this alert's own window closing, not a "
                    "re-check — it does NOT mean the workflow started passing. "
                    "Open the run to see the actual failure."
                ),
                "action": (
                    "Open the run, read why it failed, fix it. Do not re-run "
                    "the workflow from this alert — neither it nor this "
                    "watcher checks whether a retry would pass."
                ),
                "runbook": run_url,
            },
            "startsAt": starts,
            "endsAt": ends,
            "generatorURL": run_url,
        }
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--conclusion", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    missing = [
        flag
        for flag, value in (
            ("--workflow", args.workflow),
            ("--conclusion", args.conclusion),
            ("--event", args.event),
            ("--run-url", args.run_url),
            ("--run-id", args.run_id),
        )
        if not value
    ]
    if missing:
        print(
            f"::error::missing required field(s) for alert payload: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 2

    now = datetime.datetime.now(datetime.timezone.utc)
    payload = build(
        workflow=args.workflow,
        conclusion=args.conclusion,
        event=args.event,
        run_url=args.run_url,
        run_id=args.run_id,
        now=now,
    )
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
