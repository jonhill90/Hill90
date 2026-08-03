#!/usr/bin/env bash
# Is the OIDC auth method mounted on the live OpenBao? Answered WITHOUT a token.
#
# WHY THIS EXISTS
# ===============
# `vault.sh oidc_enabled` (#645) answers the same question, but it needs a valid
# token to call `bao auth list`. On a vault whose root has already been revoked
# there is no such token — which is precisely the state that needs diagnosing.
# On 2026-08-02 that left "does this vault have OIDC?" unanswerable by any
# instrument in the repo, on the one vault where the answer decided everything.
#
# THE INSTRUMENT, AND ITS CONTROLS
# ================================
# An unauthenticated POST to a login endpoint distinguishes mounted from absent:
#
#   mounted, bad/empty payload -> 400/500  (the backend ran and rejected it)
#   not mounted                -> 403      (no handler; OpenBao does not say 404)
#
# 403-means-absent is counter-intuitive enough that this script refuses to report
# anything until BOTH controls behave:
#
#   positive control  auth/approle/login   must NOT be 403  (known mounted)
#   negative control  auth/<random>/login  must BE 403      (known absent)
#
# If a control misbehaves the probe has stopped measuring what it claims to, and
# a wrong answer here is worse than no answer — this is the check that would tell
# an operator whether a vault is recoverable. It exits 2 (indeterminate) rather
# than guessing. That is the estate's own rule: verify the instrument before you
# believe the verdict — CONTRIBUTING.md.
#
# Usage:  bash scripts/checks/vault-oidc-enabled-test.sh
# Exit:   0 OIDC mounted | 1 OIDC absent | 2 indeterminate (controls failed)

set -uo pipefail

CONTAINER="${VAULT_CONTAINER:-openbao}"
ADDR="http://127.0.0.1:8200"

ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; }

# Status code for an unauthenticated POST to a v1 path.
status_for() {
    docker exec "$CONTAINER" sh -c \
        "wget -qO- --server-response --post-data='{}' \
         --header=Content-Type:application/json ${ADDR}/v1/$1 2>&1" \
        | sed -n 's|.*HTTP/1\.1 \([0-9][0-9][0-9]\).*|\1|p' | head -1
}

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "Container ${CONTAINER} is not running — cannot probe." >&2
    exit 2
fi

echo "OpenBao OIDC mount probe (unauthenticated)"
echo "=========================================="

# The negative control must be a mount that cannot plausibly exist.
ABSENT_PATH="auth/no-such-method-$$/login"

POS=$(status_for "auth/approle/login")
NEG=$(status_for "$ABSENT_PATH")
TARGET=$(status_for "auth/oidc/oidc/auth_url")

echo "  positive control  auth/approle/login        -> ${POS:-<none>}"
echo "  negative control  ${ABSENT_PATH} -> ${NEG:-<none>}"
echo "  target            auth/oidc/oidc/auth_url   -> ${TARGET:-<none>}"
echo

if [ -z "$POS" ] || [ -z "$NEG" ] || [ -z "$TARGET" ]; then
    bad "A probe returned no status code at all — the instrument is not working."
    exit 2
fi

if [ "$POS" = "403" ]; then
    bad "Positive control returned 403: a mount known to exist looks absent."
    bad "The 403-means-absent inference does not hold here. Not reporting a verdict."
    exit 2
fi
ok "positive control: a mounted method does not return 403"

if [ "$NEG" != "403" ]; then
    bad "Negative control returned ${NEG}, not 403: an absent mount does not look absent."
    bad "Not reporting a verdict."
    exit 2
fi
ok "negative control: an absent method returns 403"

echo
if [ "$TARGET" = "403" ]; then
    bad "OIDC auth method is NOT mounted (target matches the absent control)."
    echo
    echo "  Enabling it needs a root or sudo-capable token:"
    echo "    BAO_TOKEN=... bash scripts/vault.sh setup-oidc"
    echo "  If no such token exists, read"
    echo "    docs/decisions/stage2b-oidc-blocked-2026-08-02.md"
    echo "  before assuming a reinitialise is the answer."
    exit 1
fi

ok "OIDC auth method IS mounted (target does not match the absent control)."
echo
echo "  Mounted is not configured. Whether the admin-sso role binds the right"
echo "  claim is a separate question, and only a real login settles it."
exit 0
