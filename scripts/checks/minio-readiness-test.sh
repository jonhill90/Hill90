#!/usr/bin/env bash
# Regression test: minio.sh must WAIT for MinIO to start serving before it
# provisions policies, and must still fail fast on bad credentials.
#
# WHY THIS EXISTS
#
# On 2026-07-31 a push-triggered deploy recreated the minio container and ran
# `minio.sh apply` 0.3s later. MinIO was not accepting connections yet, so the
# single-shot readiness check failed with "connection refused" — and reported it
# as "Cannot authenticate ... are MINIO_ROOT_USER/MINIO_ROOT_PASSWORD correct?".
# The admin/editor/viewer policies were never created, and every federated
# AssumeRoleWithWebIdentity stayed broken with "no policy found" until someone
# ran `mc admin policy ls` by hand.
#
# The failure is timing, so the test has to be about timing. It stubs `docker`
# on PATH and drives three cases the real thing cannot be made to produce on
# demand:
#
#   1. refuse-then-ready  — the actual deploy race. Must SUCCEED after waiting.
#   2. denied             — MinIO answers and rejects the credentials. Must fail
#                           FAST, and must not blame readiness.
#   3. always-refuse      — never comes up. Must fail at the cap, legibly, and
#                           must not hang.
#
# Case 2 is why the fix is a readiness poll and not a blind retry: a retry loop
# that cannot tell "not listening" from "wrong password" spends the full cap on
# a credential error and then reports the wrong cause — which is the bug this
# test is guarding, pointed the other way.
#
# It also guards the second half of the same incident: deploy.sh printed its
# completion banner and THEN exited 1, because `docker compose ps` interpolates
# the compose file and the secrets had already left the environment.
#
# Usage: bash scripts/checks/minio-readiness-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok()   { printf '  \033[0;32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[0;31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# ---------------------------------------------------------------------------
# A stub `docker` that stands in for a MinIO container.
#
# STUB_MODE picks the behaviour; STUB_READY_AFTER is how many seconds of
# wall-clock must pass before `mc admin info` starts succeeding, so the test
# exercises real elapsed time rather than a call counter. A poll that "retries"
# without sleeping would fail case 1 exactly as the real deploy did.
# ---------------------------------------------------------------------------
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Only the two verbs minio.sh uses are modelled.
[ "${1:-}" = "inspect" ] && exit 0

if [ "${1:-}" = "exec" ]; then
    args="$*"
    now=$(date +%s)
    started=$(cat "$STUB_STATE/started" 2>/dev/null || { date +%s > "$STUB_STATE/started"; date +%s; })
    elapsed=$(( now - started ))
    echo "$elapsed" > "$STUB_STATE/last_elapsed"

    case "$args" in
        *"admin info"*)
            case "$STUB_MODE" in
                denied)
                    echo "mc: <ERROR> Unable to get service info. Access Denied." >&2
                    exit 1 ;;
                always-refuse)
                    echo "mc: <ERROR> Unable to get service info. Get \"http://127.0.0.1:9000/minio/admin/v3/info\": dial tcp 127.0.0.1:9000: connect: connection refused." >&2
                    exit 1 ;;
                refuse-then-ready)
                    if [ "$elapsed" -lt "${STUB_READY_AFTER:-5}" ]; then
                        echo "mc: <ERROR> Unable to get service info. Get \"http://127.0.0.1:9000/minio/admin/v3/info\": dial tcp 127.0.0.1:9000: connect: connection refused." >&2
                        exit 1
                    fi
                    echo "●  127.0.0.1:9000"; exit 0 ;;
            esac ;;
        *"policy ls"*)     echo "consoleAdmin"; exit 0 ;;
        *"policy create"*) exit 0 ;;
        *)                 exit 0 ;;
    esac
fi
exit 0
STUB
chmod +x "$TMP/bin/docker"

run_apply() {
    # Credentials come from the environment so secret_for short-circuits and the
    # test never touches SOPS or the age key.
    local mode="$1" timeout="$2" interval="$3" ready_after="${4:-5}"
    local state="$TMP/state.$mode.$RANDOM"
    mkdir -p "$state"
    PATH="$TMP/bin:$PATH" \
    STUB_MODE="$mode" STUB_STATE="$state" STUB_READY_AFTER="$ready_after" \
    MINIO_ROOT_USER="stub-user" MINIO_ROOT_PASSWORD="stub-pass" \
    MINIO_READY_TIMEOUT="$timeout" MINIO_READY_INTERVAL="$interval" \
    MINIO_READY_PROBE_TIMEOUT=5 \
        bash "$PROJECT_ROOT/scripts/minio.sh" apply > "$TMP/out" 2>&1
}

echo "MinIO readiness regression test"
echo "==============================="
echo ""
echo "1. The deploy race: MinIO refuses for 5s, then serves"

start=$(date +%s)
rc=0
run_apply refuse-then-ready 60 2 5 || rc=$?
elapsed=$(( $(date +%s) - start ))

if [ "$rc" -eq 0 ]; then
    ok "apply succeeded instead of dying on the cold socket"
else
    bad "apply exited ${rc} — the readiness race is not handled"
    sed 's/^/       /' "$TMP/out"
fi
if [ "$elapsed" -ge 4 ]; then
    ok "it actually waited (${elapsed}s), rather than passing by luck"
else
    bad "returned after only ${elapsed}s — it cannot have waited for readiness"
fi
if grep -qi "Policies provisioned" "$TMP/out"; then
    ok "policies were provisioned"
else
    bad "policies were not provisioned"
    sed 's/^/       /' "$TMP/out"
fi

echo ""
echo "2. Bad credentials must fail FAST and must not blame readiness"

start=$(date +%s)
rc=0
run_apply denied 60 2 || rc=$?
elapsed=$(( $(date +%s) - start ))

if [ "$rc" -ne 0 ]; then
    ok "apply failed, as it must"
else
    bad "apply SUCCEEDED against credentials MinIO rejected"
fi
if [ "$elapsed" -lt 10 ]; then
    ok "failed fast (${elapsed}s) — no waiting out the cap on an auth error"
else
    bad "took ${elapsed}s: an auth failure is being retried like a cold socket"
fi
if grep -qi "not a readiness problem" "$TMP/out"; then
    ok "the message says MinIO answered and rejected the credentials"
else
    bad "the message does not distinguish auth failure from readiness"
    sed 's/^/       /' "$TMP/out"
fi

echo ""
echo "3. Never comes up: bounded, legible, and does not hang"

start=$(date +%s)
rc=0
run_apply always-refuse 6 2 || rc=$?
elapsed=$(( $(date +%s) - start ))

if [ "$rc" -ne 0 ]; then
    ok "apply failed at the cap"
else
    bad "apply SUCCEEDED against a MinIO that never answered"
fi
if [ "$elapsed" -lt 30 ]; then
    ok "respected the ${elapsed}s cap instead of retrying forever"
else
    bad "ran ${elapsed}s against a 6s cap — the bound is not enforced"
fi
if grep -qi "did not answer within" "$TMP/out" && grep -qi "Last error" "$TMP/out"; then
    ok "failure names the cap and quotes the last error"
else
    bad "failure is not legible enough to act on"
    sed 's/^/       /' "$TMP/out"
fi

# ---------------------------------------------------------------------------
# The other half of the same incident.
# ---------------------------------------------------------------------------
echo ""
echo "4. deploy.sh must not run 'docker compose ps' outside the secret env"

COMPOSE="$PROJECT_ROOT/deploy/compose/prod/docker-compose.minio.yml"
if grep -q 'MINIO_ROOT_USER:?' "$COMPOSE"; then
    ok "premise holds: the compose file still declares a REQUIRED variable"
else
    bad "premise gone: ${COMPOSE} no longer uses \${VAR:?...}; revisit this test"
fi

# The completion block is the one that ran after the secrets had gone. Comment
# lines are stripped first: the fix explains itself by NAMING `docker compose ps`
# in a comment, and a grep that cannot tell code from prose would read that
# explanation as the bug it describes.
banner_tail=$(sed -n '/\${banner} Complete!/,/^}/p' "$PROJECT_ROOT/scripts/deploy.sh" \
    | grep -v '^[[:space:]]*#')
if printf '%s' "$banner_tail" | grep -q 'docker compose .*ps'; then
    bad "the completion banner still calls 'docker compose ps' — it will exit 1 again"
else
    ok "the completion banner does not call 'docker compose ps'"
fi
if printf '%s' "$banner_tail" | grep -q 'label=com.docker.compose.project'; then
    ok "status is listed by project label, which needs no interpolation"
else
    bad "no label-based status listing found in the completion block"
fi

echo ""
echo "5. 'deploy.sh verify minio' must not need secrets it cannot have"

# The workflow runs verify as a bare `ssh ... bash scripts/deploy.sh verify
# minio` — no `sops exec-env`, so nothing exports MINIO_ROOT_USER. A check that
# interpolates it builds "http://:@127.0.0.1:9000", MinIO answers Access Denied,
# and all 30 attempts fail against a healthy server. Third instance of one
# class: a code path needing secrets, running where the secrets are not.
verify_block=$(sed -n '/^cmd_verify()/,/^}/p' "$PROJECT_ROOT/scripts/deploy.sh" \
    | grep -v '^[[:space:]]*#')

if printf '%s' "$verify_block" | grep -q 'minio)'; then
    ok "premise holds: cmd_verify still has a minio branch"
else
    bad "no minio branch in cmd_verify; revisit this test"
fi

minio_check=$(printf '%s' "$verify_block" | grep 'minio)')
if printf '%s' "$minio_check" | grep -q 'MINIO_ROOT_USER\|MINIO_ROOT_PASSWORD'; then
    bad "the minio check interpolates root credentials that are empty here"
else
    ok "the minio check does not interpolate credentials it cannot see"
fi
if printf '%s' "$minio_check" | grep -q 'minio.sh'; then
    ok "it delegates to minio.sh, which resolves credentials from SOPS"
else
    bad "nothing resolves the credentials for the minio readiness check"
fi

echo ""
echo "==============================="
echo "passed: ${pass}  failed: ${fail}"
[ "$fail" -eq 0 ] || exit 1
