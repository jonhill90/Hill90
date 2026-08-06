#!/usr/bin/env bats

# h#752, half two: `_deploy_with_sops`'s STATELESS branch was missing the
# `set -e` its stateful sibling explicitly has and explains at length —
# `sops exec-env` runs its argument string in a NEW shell that does NOT
# inherit deploy.sh's own `set -e`, so without restating it, a failed
# `docker compose build`/`pull` would not abort; `up -d` would run anyway
# against stale or missing images.
#
# DORMANT MEANS NOT CURRENTLY CAUSING HARM — and this file exists to prove
# that claim rather than assert it. Every case arm in cmd_service's
# dispatch (db, minio, auth, vault, observability) sets `stateful=true`
# unconditionally; nothing anywhere sets it false. `deploy_mode` defaults
# to "stateless" and only ever becomes "stateful" when `stateful=true`, so
# for every service this script can currently deploy, `_deploy_with_sops`
# is ALWAYS called with "stateful" — the branch this fix touches is
# unreachable today, mechanically, not by luck.
#
# WHETHER ADDING set -e CHANGES ANYTHING TODAY IS ANSWERED BY RUNNING IT,
# NOT BY READING IT. Two things are shown, separately, because they answer
# different questions:
#   1. The five real services' own dispatch logic never selects
#      "stateless" — proven by exercising the actual case-arm variables,
#      not by trusting the grep above.
#   2. The changed branch itself, called directly (bypassing dispatch, the
#      only way to reach it at all today) is NOT a no-op once reached: a
#      failing `docker compose build` now aborts instead of continuing to
#      `up -d` — proving the fix does something real, for the day a
#      stateless service exists. The SUCCESS path (what every hypothetical
#      future stateless deploy looks like when nothing fails) is diffed
#      byte-for-byte between the pre-fix and post-fix branch bodies and
#      found IDENTICAL — the fix costs nothing when nothing is wrong.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    DEPLOY="$ROOT/scripts/deploy.sh"

    STUB="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB"
    PATH="$STUB:$PATH"

    # A minimal exec-env that just runs the script string directly — no
    # real secrets file or decryption needed to observe the SHELL LOGIC
    # this fix changes.
    cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "exec-env" ]; then
    shift 2
    exec bash -c "$1"
fi
exit 1
EOF
    chmod +x "$STUB/sops"

    HARNESS_VARS='
SCRIPT_DIR="'"$BATS_TEST_TMPDIR"'"
secrets_file="/dev/null"
pre_up_hook=""
service="testsvc"
project_name="test-project"
compose_file="test.yml"
containers="testsvc"
'
}

# $1 = 0 (docker succeeds) or 1 (docker build fails)
make_docker_stub() {
    if [ "$1" -eq 0 ]; then
        cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*"
exit 0
EOF
    else
        cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*"
if [[ "$*" == *"build"* ]]; then
    echo "SIMULATED BUILD FAILURE" >&2
    exit 1
fi
exit 0
EOF
    fi
    chmod +x "$STUB/docker"
}

extract_deploy_with_sops() {
    sed -n '/^    _deploy_with_sops() {$/,/^    }$/p' "$DEPLOY"
}

# PINNED FIXTURE, not a git reference. The three arms below used to
# reconstruct "pre-fix" via `git -C "$ROOT" show HEAD:scripts/deploy.sh` —
# which stops meaning "pre-fix" the instant this fix is committed, because
# HEAD then IS the fix. One arm (the control) started failing outright;
# the other two (the no-op and untouched-sibling claims) started diffing
# the fixed code against itself and passing vacuously, which is worse,
# because a green test that cannot fail reads as coverage.
#
# This is the literal body of `_deploy_with_sops` from the commit
# immediately before this fix (c522ffb1, the parent of 1fbf204a) — byte
# for byte, confirmed via `git show c522ffb1:scripts/deploy.sh | sed -n
# '/^    _deploy_with_sops() {$/,/^    }$/p'`. It cannot drift with the
# branch because nothing here reads git state at test time.
pre_fix_deploy_with_sops_body() {
    cat <<'PRE_FIX_FIXTURE'
    _deploy_with_sops() {
        local mode="$1"  # "stateful" or "stateless"
        if [ "$mode" = "stateful" ]; then
            sops exec-env "$secrets_file" '
                set -e
                if [ -n "'"$pre_up_hook"'" ]; then
                    # ALERT_EMAIL_TO falls back to ACME_EMAIL: both are addresses
                    # already configured in the store, and ACME_EMAIL is already
                    # where certificate-expiry notices go. The fallback is to
                    # another explicit value, never to a hardcoded guess — the
                    # render script still refuses if both are empty.
                    export ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-$ACME_EMAIL}"
                    bash "'"$SCRIPT_DIR"'/'"$pre_up_hook"'"
                fi
                echo "Stopping existing '"$service"' containers..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' down || true
                for container in '"$containers"'; do
                    docker rm -f "$container" 2>/dev/null || true
                done
                echo "Building and pulling images..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' build --parallel --no-cache
                docker compose -p "'"$project_name"'" -f '"$compose_file"' pull --ignore-buildable
                echo "Deploying '"$service"' service..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' up -d
            '
        else
            sops exec-env "$secrets_file" '
                echo "Building and pulling images..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' build --parallel --no-cache
                docker compose -p "'"$project_name"'" -f '"$compose_file"' pull --ignore-buildable
                echo "Deploying '"$service"' service..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' up -d --force-recreate --no-deps
            '
        fi
    }
PRE_FIX_FIXTURE
}

build_harness() {
    local out="$1"
    {
        echo "#!/usr/bin/env bash"
        echo "$HARNESS_VARS"
        extract_deploy_with_sops
    } > "$out"
}

@test "sanity: exactly five case arms set stateful=true and none set it false" {
    run grep -c 'stateful=true' "$DEPLOY"
    [ "$output" -eq 5 ]
    run grep -c 'stateful=false' "$DEPLOY"
    [ "$output" -eq 0 ]
}

@test "THE FIVE REAL SERVICES: each one's own dispatch resolves to stateful, never stateless — exercised, not just grepped" {
    # Extracts cmd_service's own case statement and deploy_mode computation
    # verbatim, and runs it once per real service name, asserting the
    # variable it actually assigns — not a hand-copied re-statement of the
    # case arms.
    local block
    block=$(sed -n '/^    local compose_file banner containers summary stack stateful pre_up_hook$/,/^    esac$/p' "$DEPLOY")
    [ -n "$block" ]

    local mode_calc
    mode_calc=$(sed -n '/^    local deploy_mode="stateless"$/,/^    \[ "\$stateful" = true \] && deploy_mode="stateful"$/p' "$DEPLOY")
    [ -n "$mode_calc" ]

    for svc in db minio auth vault observability; do
        run bash -c "
            set -uo pipefail
            service='${svc}'
            env='prod'
            SCRIPT_DIR='/tmp'
            ${block}
            ${mode_calc}
            echo \"MODE=\${deploy_mode}\"
        "
        [ "$status" -eq 0 ]
        [[ "$output" == *"MODE=stateful"* ]]
    done
}

@test "THE STATELESS BRANCH ITSELF, called directly (the only way to reach it today): a failed build now aborts instead of continuing to up -d" {
    make_docker_stub 1
    build_harness "$BATS_TEST_TMPDIR/harness.sh"

    run bash -c '
        source "'"$BATS_TEST_TMPDIR"'/harness.sh"
        _deploy_with_sops "stateless"
    '

    [ "$status" -ne 0 ]
    [[ "$output" == *"SIMULATED BUILD FAILURE"* ]]
    # THE ASSERTION THAT MATTERS: up -d must never have been reached.
    [[ "$output" != *"up -d"* ]]
}

@test "CONTROL, THE DORMANT RISK REPRODUCED: the pre-fix stateless branch (no set -e) continues past the same failed build to up -d" {
    make_docker_stub 1
    {
        echo "#!/usr/bin/env bash"
        echo "$HARNESS_VARS"
        pre_fix_deploy_with_sops_body
    } > "$BATS_TEST_TMPDIR/harness_old.sh"

    run bash -c '
        source "'"$BATS_TEST_TMPDIR"'/harness_old.sh"
        _deploy_with_sops "stateless"
    '

    [ "$status" -eq 0 ]
    [[ "$output" == *"SIMULATED BUILD FAILURE"* ]]
    # The old shape: the build failure is visible in the log, but nothing
    # stopped for it — up -d ran anyway.
    [[ "$output" == *"up -d --force-recreate --no-deps"* ]]
}

@test "THE STATELESS BRANCH ITSELF, called directly: the fix is a no-op on the SUCCESS path — byte-for-byte identical output to pre-fix" {
    make_docker_stub 0

    build_harness "$BATS_TEST_TMPDIR/harness_post.sh"
    {
        echo "#!/usr/bin/env bash"
        echo "$HARNESS_VARS"
        pre_fix_deploy_with_sops_body
    } > "$BATS_TEST_TMPDIR/harness_pre.sh"

    bash -c '
        source "'"$BATS_TEST_TMPDIR"'/harness_pre.sh"
        _deploy_with_sops "stateless"
    ' > "$BATS_TEST_TMPDIR/pre.out" 2>&1
    pre_status=$?

    bash -c '
        source "'"$BATS_TEST_TMPDIR"'/harness_post.sh"
        _deploy_with_sops "stateless"
    ' > "$BATS_TEST_TMPDIR/post.out" 2>&1
    post_status=$?

    [ "$pre_status" -eq "$post_status" ]
    run diff "$BATS_TEST_TMPDIR/pre.out" "$BATS_TEST_TMPDIR/post.out"
    [ "$status" -eq 0 ]
}

@test "THE STATEFUL SIBLING IS UNTOUCHED: this diff adds a line only inside the stateless branch" {
    # The stateful branch's OWN behaviour must be provably unaffected — not
    # merely unlikely to be — since this diff should not touch a single
    # line it executes. Confirmed by diffing the stateful branch's body
    # specifically between pre-fix and this file.
    local pre post
    pre=$(pre_fix_deploy_with_sops_body | sed -n '/^        if \[ "\$mode" = "stateful" \]; then$/,/^        else$/p')
    post=$(sed -n '/^        if \[ "\$mode" = "stateful" \]; then$/,/^        else$/p' "$DEPLOY")
    [ "$pre" = "$post" ]
}
