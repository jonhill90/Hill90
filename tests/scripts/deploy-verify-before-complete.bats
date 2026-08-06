#!/usr/bin/env bats

# h#752, half one: "Complete!" used to print the instant `docker compose up
# -d` returned — proof containers STARTED, not that they are healthy. This
# is the estate's own defining defect (an operation that succeeds while
# proving nothing) wearing its plainest form: the script announces success
# for work it did not confirm.
#
# WHICH PATHS REACHED "Complete!" WITHOUT A VERIFY, established before
# choosing the fix. `cmd_service`'s workflow (reusable-deploy-service.yml)
# already runs `deploy.sh verify <service>` as a separate mandatory step
# after deploying — so a CI-driven deploy of db/auth/minio/vault/
# observability was already caught by the WORKFLOW if health failed, even
# though the SCRIPT's own "Complete!" line was printed regardless.
# `cmd_infra`'s workflow (deploy-infra.yml) does its own bespoke inline
# checks (container status, Traefik logs, TLS) rather than calling
# `deploy.sh verify infra` — also real verification, just not via this
# function. Neither workflow finding changes what this fixes: anyone
# invoking `deploy.sh infra` or `deploy.sh <service>` directly — which the
# docs do reference — got "Complete!" with no verification at all, from the
# script itself. `cmd_teardown` was checked too and correctly excluded: it
# never prints "Complete!" (it prints "torn down", a genuinely different and
# already-honest claim), so forcing a verify there would be forcing one onto
# a command that never claimed health in the first place.
#
# THE FIX: cmd_verify is called immediately before each "Complete!" banner,
# for both cmd_infra and cmd_service. cmd_verify already covers every
# service either function can deploy (including "infra"), so no new
# check logic — this makes the STANDALONE path honest using what already
# existed, rather than inventing something new. cmd_verify calls `exit 1`
# on failure (not `return`), so a failing check aborts the whole script and
# "Complete!" is never reached.
#
# Every assertion here is about whether "Complete!" was ACTUALLY PRINTED,
# not about a verify function being reachable in principle.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    CTL="$BATS_TEST_TMPDIR/ctl"
    mkdir -p "$CTL/scripts" "$CTL/bin" "$CTL/deploy/compose/prod" "$CTL/infra/secrets/keys"
    cp "$ROOT/scripts/deploy.sh" "$CTL/scripts/deploy.sh"
    cp "$ROOT/scripts/_common.sh" "$CTL/scripts/_common.sh"

    # Fixture compose/secrets files — never read for real content, just need
    # to exist for require_file to pass.
    touch "$CTL/deploy/compose/prod/docker-compose.db.yml"
    touch "$CTL/deploy/compose/prod/docker-compose.infra.yml"
    touch "$CTL/infra/secrets/prod.enc.env"
    touch "$CTL/infra/secrets/keys/age-prod.key"

    STUB="$CTL/bin"
    PATH="$STUB:$PATH"

    # sops: exec-env just runs the script directly, no real decryption — the
    # stateful branch's `set -e`-guarded body only ever calls docker, which
    # is separately stubbed below. `-d` (used by secret_value/vault paths)
    # returns nothing so those callers fall through their own "could not
    # resolve" branches, which are already handled with a warned assumption.
    cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "exec-env" ]; then
    shift 2
    exec bash -c "$1"
fi
exit 1
EOF
    chmod +x "$STUB/sops"

    # Fast retry loop: cmd_verify's own default is 30 attempts * 2s sleep.
    export DEPLOY_VERIFY_MAX_ATTEMPTS=1
}

# $1 = 0 for a verify check that PASSES, 1 for one that FAILS. Controls the
# `docker exec postgres psql ...` / `docker exec traefik wget ...` command
# cmd_verify's own `eval "$check_cmd"` runs — everything else docker is
# asked to do (network inspect, ps, rm, compose) succeeds trivially, since
# this file is about the verify wiring, not about compose semantics.
make_docker_stub() {
    local verify_exit="$1"
    cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "exec" ]; then
    exit ${verify_exit}
fi
if [ "\$1" = "network" ] && [ "\$2" = "inspect" ]; then
    exit 0
fi
if [ "\$1" = "inspect" ]; then
    echo "unknown"
    exit 0
fi
if [ "\$1" = "logs" ]; then
    exit 0
fi
exit 0
EOF
    chmod +x "$STUB/docker"
}

# deploy.sh has no --source-only guard (it runs main "$@" unconditionally at
# the bottom), so sourcing it directly would immediately try to dispatch
# argv as a command. Extract just the functions this test needs instead —
# the same block-extraction convention already used elsewhere in this
# suite — so the REAL cmd_service/cmd_verify bodies run, not a
# reimplementation of them.
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
    sed -n '/^cmd_infra() {/,/^}/p' "$CTL/scripts/deploy.sh" >> "$out"
}

@test "THE ASSERTION THAT MATTERS (cmd_service): Complete! is NOT printed when verification fails" {
    make_docker_stub 1  # docker exec (the health check) fails every time
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_service db prod
    '

    [ "$status" -ne 0 ]
    [[ "$output" != *"Database Deployment Complete!"* ]]
    [[ "$output" == *"failed readiness check"* ]]
}

@test "CONTROL (cmd_service): Complete! IS printed, and verify genuinely ran, when the health check passes" {
    make_docker_stub 0
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_service db prod
    '

    [ "$status" -eq 0 ]
    [[ "$output" == *"Database Deployment Complete!"* ]]
    # Not just "no error" — proof the check actually executed and reported
    # its own real result, not merely that nothing crashed on the way past.
    [[ "$output" == *"✓ db is healthy"* ]]
}

@test "THE ASSERTION THAT MATTERS (cmd_infra): Complete! is NOT printed when verification fails" {
    make_docker_stub 1
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_infra prod
    '

    [ "$status" -ne 0 ]
    [[ "$output" != *"Edge Stack Deployment Complete!"* ]]
    [[ "$output" == *"failed readiness check"* ]]
}

@test "CONTROL (cmd_infra): Complete! IS printed when the health check passes" {
    make_docker_stub 0
    build_harness "$CTL/harness.sh"

    run bash -c '
        source "'"$CTL"'/harness.sh"
        cmd_infra prod
    '

    [ "$status" -eq 0 ]
    [[ "$output" == *"Edge Stack Deployment Complete!"* ]]
    [[ "$output" == *"✓ infra is healthy"* ]]
}

@test "CONTROL, THE OLD BUG REPRODUCED: before this fix, Complete! printed regardless of health" {
    # Reconstructs the pre-fix shape inline — cmd_service with no cmd_verify
    # call before its banner — so the SHAPE being caught (an unconfirmed
    # success banner) is what's proven, not tied to one git revision.
    make_docker_stub 1
    cat > "$CTL/harness_old.sh" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
cmd_service_old() {
    echo "================================"
    echo "Database Deployment - prod"
    echo "================================"
    docker compose -p test up -d >/dev/null 2>&1 || true
    echo ""
    echo "================================"
    echo "Database Deployment Complete!"
    echo "================================"
}
HARNESS
    run bash -c '
        source "'"$CTL"'/harness_old.sh"
        cmd_service_old
    '
    [ "$status" -eq 0 ]
    [[ "$output" == *"Database Deployment Complete!"* ]]
}
