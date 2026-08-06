#!/usr/bin/env bats

# h#811: the build cache grew 9.3GB -> 41.9GB in six days, then to 49.7GB
# within another ~10 hours, with Prometheus's own 7-day history showing the
# growth ACCELERATING (the last 3 of 7 days alone accounted for 32 of the
# 39 GiB the whole week lost). prune_builder_cache() (scripts/_common.sh) is
# the fix: a size-capped `docker builder prune --keep-storage <N> --force`,
# called at the end of every cmd_service deploy in scripts/deploy.sh.
#
# WHAT MATTERS HERE, per the same discipline the sibling
# deploy-verify-before-complete.bats file states in its own header: not
# "prune_builder_cache exists and can be called", but that it is ACTUALLY
# WIRED into the real deploy path, that it uses a SIZE ceiling (not an age
# filter — see the function's own comment for why that distinction is the
# actual fix), and that a failure inside it can never abort or fail a
# deploy — housekeeping must not be able to make a healthy deploy look
# broken.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    CTL="$BATS_TEST_TMPDIR/ctl"
    mkdir -p "$CTL/scripts" "$CTL/bin" "$CTL/deploy/compose/prod" "$CTL/infra/secrets/keys"
    cp "$ROOT/scripts/deploy.sh" "$CTL/scripts/deploy.sh"
    cp "$ROOT/scripts/_common.sh" "$CTL/scripts/_common.sh"

    touch "$CTL/deploy/compose/prod/docker-compose.db.yml"
    touch "$CTL/infra/secrets/prod.enc.env"
    touch "$CTL/infra/secrets/keys/age-prod.key"

    STUB="$CTL/bin"
    PATH="$STUB:$PATH"

    cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "exec-env" ]; then
    shift 2
    exec bash -c "$1"
fi
exit 1
EOF
    chmod +x "$STUB/sops"

    export DEPLOY_VERIFY_MAX_ATTEMPTS=1

    DOCKER_CALLS_LOG="$CTL/docker-calls.log"
    export DOCKER_CALLS_LOG
}

# $1: exit code `docker builder prune` itself should return (0 = succeeds,
# 1 = fails, simulating e.g. a daemon that briefly refuses the command).
# Every call is appended to DOCKER_CALLS_LOG so a test can assert not just
# "the script didn't crash" but "this exact command ran".
make_docker_stub() {
    local prune_exit="${1:-0}"
    cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$DOCKER_CALLS_LOG"
if [ "\$1" = "builder" ] && [ "\$2" = "prune" ]; then
    exit ${prune_exit}
fi
if [ "\$1" = "system" ] && [ "\$2" = "df" ]; then
    echo "Build Cache: 49.7GB (47.12GB reclaimable)"
    exit 0
fi
if [ "\$1" = "exec" ]; then
    exit 0
fi
if [ "\$1" = "network" ] && [ "\$2" = "inspect" ]; then
    exit 0
fi
if [ "\$1" = "inspect" ]; then
    echo "unknown"
    exit 0
fi
exit 0
EOF
    chmod +x "$STUB/docker"
}

build_harness() {
    local out="$1"
    cat > "$out" <<HARNESS
#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$CTL/scripts"
cd "$CTL"
source scripts/_common.sh
HARNESS
    sed -n '/^cmd_verify() {/,/^}/p' "$CTL/scripts/deploy.sh" >> "$out"
    sed -n '/^cmd_service() {/,/^}/p' "$CTL/scripts/deploy.sh" >> "$out"
}

# ------------------------------------------------------- unit, direct call ---

@test "prune_builder_cache defaults to a 15GB ceiling" {
    make_docker_stub 0
    run bash -c '
        source "'"$CTL"'/scripts/_common.sh"
        prune_builder_cache
    '
    [ "$status" -eq 0 ]
    grep -qE '^builder prune --keep-storage 15GB --force$' "$DOCKER_CALLS_LOG"
}

@test "prune_builder_cache honors an explicit keep-storage value" {
    make_docker_stub 0
    run bash -c '
        source "'"$CTL"'/scripts/_common.sh"
        prune_builder_cache 5GB
    '
    [ "$status" -eq 0 ]
    grep -qE '^builder prune --keep-storage 5GB --force$' "$DOCKER_CALLS_LOG"
}

@test "SIZE, NOT AGE: the call carries --keep-storage, never a --filter until=... age cutoff" {
    # h#811's own point: an age filter lets cache keep growing for up to its
    # window before the oldest entries qualify — the exact shape that let
    # this reach 49.7GB unnoticed. Pinning the flag shape so a future edit
    # cannot quietly revert to the disk-capacity.md doc's original
    # (superseded) `--filter until=168h` suggestion.
    make_docker_stub 0
    bash -c '
        source "'"$CTL"'/scripts/_common.sh"
        prune_builder_cache
    ' >/dev/null
    run cat "$DOCKER_CALLS_LOG"
    [[ "$output" != *"--filter"* ]]
    [[ "$output" == *"--keep-storage"* ]]
}

@test "POSITIVE CONTROL: prune_builder_cache is NEVER FATAL — a failing prune does not propagate" {
    make_docker_stub 1  # docker builder prune itself fails every time
    run bash -c '
        set -e
        source "'"$CTL"'/scripts/_common.sh"
        prune_builder_cache
        echo REACHED_THE_END
    '
    [ "$status" -eq 0 ]
    [[ "$output" == *"REACHED_THE_END"* ]]
    [[ "$output" == *"WARNING"* ]]
}

# ----------------------------------------------------- wired into cmd_service ---

@test "cmd_service actually calls prune_builder_cache — not just defined, invoked" {
    make_docker_stub 0
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_service db prod
    '
    [ "$status" -eq 0 ]
    grep -qE '^builder prune --keep-storage 15GB --force$' "$DOCKER_CALLS_LOG"
}

@test "a failing prune does not turn a healthy deploy into a failed one" {
    make_docker_stub 1  # builder prune fails; the health check itself still passes (docker exec -> 0 via the default branch)
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_service db prod
    '
    [ "$status" -eq 0 ]
    [[ "$output" == *"Database Deployment Complete!"* ]]
}

@test "CONTROL: the prune runs AFTER cmd_verify, not before — housekeeping never gates the health check" {
    make_docker_stub 0
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_service db prod
    '
    [ "$status" -eq 0 ]
    verify_line=$(grep -n '✓ db is healthy' <<< "$output" | head -1 | cut -d: -f1)
    complete_line=$(grep -n 'Database Deployment Complete!' <<< "$output" | head -1 | cut -d: -f1)
    [ -n "$verify_line" ]
    [ -n "$complete_line" ]
    [ "$verify_line" -lt "$complete_line" ]
}
