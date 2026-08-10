"""Command line interface for Hill90's portable supervisor ledger."""

from __future__ import annotations

import argparse
import json
import os
import secrets
from pathlib import Path

from adapter import TmuxAdapter
from core import Ledger
from github_source import GithubTaskSource
from sensor import StateSensor
from transport import TmuxTransport


DEFAULT_STATE = Path.home() / ".local/state/hill90-supervisor"
DEFAULT_REPOSITORIES = (
    {"name": "Hill90", "path": "/Users/jon/source/repos/Personal/Hill90", "github": "jonhill90/Hill90"},
    {"name": "hill90-app", "path": "/Users/jon/source/repos/Personal/hill90-app", "github": "jonhill90/hill90-app"},
    {"name": "hill90-docs", "path": "/Users/jon/source/repos/Personal/hill90-docs", "github": "jonhill90/hill90-docs"},
)


def parser():
    root = argparse.ArgumentParser()
    root.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    root.add_argument("--tmux-bin", default=os.environ.get("HILL90_TMUX_BIN", "tmux"))
    sub = root.add_subparsers(dest="command", required=True)

    register = sub.add_parser("register")
    register.add_argument("--lane", required=True)
    register.add_argument("--target", required=True)
    register.add_argument("--harness", choices=("codex", "claude"), required=True)
    register.add_argument("--repo", required=True)
    register.add_argument("--nonce")

    assign = sub.add_parser("assign")
    assign.add_argument("--lane", required=True)
    assign.add_argument("--task", required=True)
    assign.add_argument("--summary", required=True)

    for name in ("accept", "complete"):
        command = sub.add_parser(name)
        command.add_argument("--task", required=True)
        if name == "complete":
            command.add_argument("--result-file", type=Path, required=True)

    reconcile = sub.add_parser("reconcile")
    reconcile.add_argument("--task", required=True)
    reconcile.add_argument("--outcome", choices=("delivered", "failed"), required=True)

    observe = sub.add_parser("observe")
    observe.add_argument("--lane", action="append")

    notify = sub.add_parser("notify")
    notify.add_argument("--architecture-lane", default="architecture")
    notify.add_argument("--retry-after", type=int, default=900)

    tick = sub.add_parser("tick")
    tick.add_argument("--architecture-lane", default="architecture")
    tick.add_argument("--retry-after", type=int, default=900)
    tick.add_argument("--no-sensors", action="store_true")
    tick.add_argument("--sensor-timeout", type=int, default=30)

    sub.add_parser("sensor")

    events = sub.add_parser("events")
    events.add_argument("--due", action="store_true")

    ack = sub.add_parser("ack")
    ack.add_argument("--event", action="append", required=True)
    ack.add_argument("--architecture-lane", default="architecture")

    reconstruct = sub.add_parser("reconstruct")
    reconstruct.add_argument("--source-url", required=True)
    reconstruct.add_argument("--source-ref", required=True)

    sub.add_parser("status")
    return root


def _print(value):
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))


def _verify_caller(adapter, ledger, lane):
    record = adapter._verified_lane(lane)
    caller = os.environ.get("TMUX_PANE")
    if caller and caller != record["pane_id"]:
        raise RuntimeError(f"caller pane {caller} does not own lane {lane}")
    return record


def main(argv=None):
    args = parser().parse_args(argv)
    ledger = Ledger(args.state_dir)
    adapter = TmuxAdapter(ledger, TmuxTransport(args.tmux_bin))

    if args.command == "register":
        value = adapter.register_lane(
            lane=args.lane,
            target=args.target,
            harness=args.harness,
            repo=args.repo,
            nonce=args.nonce or secrets.token_hex(16),
        )
    elif args.command == "assign":
        value = adapter.assign_task(lane=args.lane, task_id=args.task, summary=args.summary)
    elif args.command == "accept":
        task = ledger.get_task(args.task)
        if task is None:
            raise ValueError("unknown task")
        lane = ledger.get_lane(task["lane"])
        _verify_caller(adapter, ledger, task["lane"])
        value = ledger.accept(args.task, pane_nonce=lane["nonce"])
    elif args.command == "complete":
        task = ledger.get_task(args.task)
        if task is None:
            raise ValueError("unknown task")
        _verify_caller(adapter, ledger, task["lane"])
        value = ledger.complete(args.task, args.result_file.read_bytes())
    elif args.command == "reconcile":
        # Deliberately not caller-verified and deliberately not the lane's
        # *current* nonce: this is the human-operator path for an ambiguous
        # delivery, run from outside the (possibly stuck, dead, or since
        # re-registered) pane after inspecting it directly. Authentication
        # uses the task's own recorded pane_nonce from send time - see
        # Ledger._reconcile_transition. It never infers its answer from tmux
        # capture.
        task = ledger.get_task(args.task)
        if task is None:
            raise ValueError("unknown task")
        value = ledger.reconcile_delivery(args.task, pane_nonce=task["pane_nonce"], outcome=args.outcome)
    elif args.command == "observe":
        lanes = args.lane or [item["lane"] for item in ledger.list_lanes() if item["lane"] != "architecture"]
        value = [event for lane in lanes if (event := adapter.observe_lane(lane)) is not None]
    elif args.command == "notify":
        value = {"notified": adapter.notify_architecture(lane=args.architecture_lane, retry_after=args.retry_after)}
    elif args.command == "tick":
        with ledger.operation_lock():
            sensor_result = {"events": [], "errors": [], "recoveries": []}
            if not args.no_sensors:
                sensor_result = StateSensor(
                    ledger, repositories=DEFAULT_REPOSITORIES, timeout=args.sensor_timeout
                ).collect_all()
            sensor_blockers = sorted(
                error["component"] for error in sensor_result["errors"] if error["component"].startswith("github-")
            )
            if args.no_sensors:
                sensor_blockers.append("github-sensor-disabled")
            gated = bool(sensor_blockers)
            observations = []
            errors = []
            notified = False
            if not gated:
                for lane in ledger.list_lanes():
                    if lane["lane"] == args.architecture_lane:
                        continue
                    try:
                        event = adapter.observe_lane(lane["lane"])
                        if event is not None:
                            observations.append(event["key"])
                        ledger.record_component(f"lane:{lane['lane']}", snapshot=b"reachable", healthy=True)
                    except Exception as error:  # a bad worker lane must not blind the others
                        ledger.record_component(f"lane:{lane['lane']}", healthy=False, error=str(error))
                        errors.append({"lane": lane["lane"], "error": str(error)})
                try:
                    notified = adapter.notify_architecture(lane=args.architecture_lane, retry_after=args.retry_after)
                    ledger.record_component("architecture", snapshot=b"reachable", healthy=True)
                except Exception as error:
                    ledger.record_component("architecture", healthy=False, error=str(error))
                    errors.append({"lane": args.architecture_lane, "error": str(error)})
                    notified = False
        value = {
            "sensor_events": sensor_result["events"],
            "sensor_recoveries": sensor_result["recoveries"],
            "sensor_blockers": sensor_blockers,
            "gated": gated,
            "observations": observations,
            "notified": notified,
            "errors": sensor_result["errors"] + errors,
        }
    elif args.command == "sensor":
        value = StateSensor(ledger, repositories=DEFAULT_REPOSITORIES).collect_all()
    elif args.command == "events":
        value = ledger.events_due() if args.due else ledger.list_events()
    elif args.command == "ack":
        _verify_caller(adapter, ledger, args.architecture_lane)
        ledger.ack(args.event)
        value = {"acked": args.event}
    elif args.command == "reconstruct":
        value = GithubTaskSource().reconstruct(
            ledger, source_url=args.source_url, source_ref=args.source_ref
        )
    elif args.command == "status":
        value = {
            "lanes": ledger.list_lanes(),
            "source_tasks": ledger.list_source_tasks(),
            "tasks": ledger.list_tasks(),
            "events": ledger.list_events(),
        }
    else:
        raise AssertionError(args.command)
    _print(value)
    return 0
