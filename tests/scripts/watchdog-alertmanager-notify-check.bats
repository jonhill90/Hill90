#!/usr/bin/env bats
#
# POSITIVE CONTROL for the "Check Alertmanager's own notify log for this
# alert" step in .github/workflows/scheduled-checks-watchdog.yml.
#
# Before this fix, `docker logs ... | grep -i "notify\|smtp\|email" || echo
# "(no matching log lines...)"` made the step's exit code whichever of grep
# or echo ran — grep exits 0 the instant it matches ANY line, including a
# genuine Alertmanager delivery-FAILURE line, so the step could never fail
# regardless of what it found. This is the watchdog's own last-mile
# confirmation that an alert reached Alertmanager's notification pipeline —
# a check that cannot fail there is decorative at the one layer meant to be
# the backstop when every other scheduled check goes red.
#
# The fixture log lines below are not invented: captured verbatim from a
# real prom/alertmanager:v0.28.1 container (the version pinned in
# deploy/compose/prod/docker-compose.observability.yml) with a webhook
# receiver pointed at an unreachable address, and — separately — from the
# same container with a receiver that accepted every POST cleanly (which
# logs NOTHING matching notify|smtp|email at this verbosity; that absence is
# why "no matching lines" stays a soft pass rather than being promoted to a
# hard failure).
#
# This extracts the exact `run:` body from the workflow YAML (substituting
# `docker logs --since=2m alertmanager` for `cat "$FIXTURE"` so it can run
# against a file instead of SSH+docker) and asserts on it directly, so a
# future edit to the step is re-tested against the same fixtures rather than
# re-verified by hand.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    WORKFLOW="$ROOT/.github/workflows/scheduled-checks-watchdog.yml"
    SCRIPT="$BATS_TEST_TMPDIR/step.sh"

    # Extract the step's run: body, pull out just the single-quoted remote
    # script inside the ssh invocation, and swap the docker-logs source for
    # a file read — so the same classification logic runs against a
    # fixture. Reads/writes real files throughout (not stdin piping into a
    # heredoc'd `python3 -`, which silently drops the pipe: a heredoc
    # attached to the same command overrides its stdin).
    python3 - "$WORKFLOW" "$SCRIPT" <<'PY'
import sys, yaml
workflow_path, out_path = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(workflow_path))
run_body = None
for s in d["jobs"]["notify"]["steps"]:
    if s.get("name", "").startswith("Check Alertmanager's own notify log"):
        run_body = s["run"]
        break
assert run_body, "could not find the 'Check Alertmanager's own notify log' step — did its name change?"
first = run_body.index("'")
last = run_body.rindex("'")
remote_body = run_body[first + 1:last]
remote_body = remote_body.replace(
    'docker logs --since=2m alertmanager 2>&1', 'cat "$FIXTURE"'
)
open(out_path, "w").write(remote_body)
PY
    REMOTE_BODY="$(cat "$SCRIPT")"
}

@test "extraction sanity: the step body was found and is non-trivial" {
    [ -n "$REMOTE_BODY" ]
    [[ "$REMOTE_BODY" == *"LOG_LINES"* ]]
}

@test "REAL delivery failure (captured from prom/alertmanager:v0.28.1) fails the step" {
    FIXTURE="$BATS_TEST_TMPDIR/failure.log"
    cat > "$FIXTURE" <<'LOG'
time=2026-08-05T10:30:26.253Z level=INFO source=main.go:196 msg="Starting Alertmanager"
time=2026-08-05T10:30:26.253Z level=WARN source=notify.go:866 msg="Notify attempt failed, will retry later" component=dispatcher receiver=webhook-fail integration=webhook[0] aggrGroup={}:{} attempts=1 err="Post \"http://127.0.0.1:1/unreachable\": dial tcp 127.0.0.1:1: connect: connection refused"
LOG
    run env FIXTURE="$FIXTURE" bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"* ]]
    [[ "$output" == *"delivery failure"* ]]
}

@test "REAL clean run (captured from the same container with a working receiver) stays a soft pass" {
    # Alertmanager logs NOTHING matching notify|smtp|email at info verbosity
    # for a notification it delivered successfully — confirmed against a
    # real container with an HTTP receiver that accepted every POST. Only
    # ordinary startup/cluster lines are present.
    FIXTURE="$BATS_TEST_TMPDIR/clean.log"
    cat > "$FIXTURE" <<'LOG'
time=2026-08-05T10:27:43.297Z level=INFO source=main.go:196 msg="Starting Alertmanager"
time=2026-08-05T10:27:00.926Z level=INFO source=cluster.go:699 msg="gossip settled; proceeding" component=cluster elapsed=10.005304296s
LOG
    run env FIXTURE="$FIXTURE" bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"cannot confirm a send was attempted"* ]]
}

@test "CONTROL: the OLD grep-only logic could not fail on the same real failure log (regression guard)" {
    # Not a test of the new step — a permanent record that the bug was real.
    # If this ever starts failing, the old shape has been reintroduced
    # elsewhere and this comment is the only thing that will say why it
    # matters.
    FIXTURE="$BATS_TEST_TMPDIR/failure2.log"
    cat > "$FIXTURE" <<'LOG'
time=2026-08-05T10:30:26.253Z level=WARN source=notify.go:866 msg="Notify attempt failed, will retry later" component=dispatcher receiver=webhook-fail integration=webhook[0] aggrGroup={}:{} attempts=1 err="Post \"http://127.0.0.1:1/unreachable\": dial tcp 127.0.0.1:1: connect: connection refused"
LOG
    run bash -c 'cat "$1" | grep -i "notify\|smtp\|email" || echo "(no matching log lines in the last 2 minutes)"' -- "$FIXTURE"
    [ "$status" -eq 0 ]
}

@test "CONTROL: a match with no failure indicator stays a soft pass, not a false alarm" {
    FIXTURE="$BATS_TEST_TMPDIR/benign.log"
    cat > "$FIXTURE" <<'LOG'
time=2026-08-05T10:30:26.253Z level=INFO source=email.go:40 msg="Configured email notify integration" receiver=team-email
LOG
    run env FIXTURE="$FIXTURE" bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no failure indicator"* ]]
}
