#!/usr/bin/env bash
#
# Does the Keycloak hill90-ui client's secret still agree with the secret
# app-ui was started with?
#
# NEITHER side ever appears here. This takes two sha256 hex digests, computed
# by the caller from wherever each secret actually lives, and compares them.
# The plaintext never reaches this script, never reaches a shell variable
# outside the process that read it, and never appears in a log.
#
# WHY AGREEMENT, NOT SAMENESS-OVER-TIME. A hash of the live secret with
# nothing to compare it to looks like evidence and is not — that was the gap
# in the first version of this check, closed after Jon compared the two sides
# by hand on the host and found they agreed (2026-08-04). The property that
# actually matters is not "is this the same secret as an earlier reading", it
# is "do the two sides that must agree still agree": a coordinated rotation
# of both changes the hash on both sides and breaks nothing — this stays
# quiet. The two drifting apart — one side restarted with an old value, one
# side's secret regenerated without the other being updated — is the actual
# outage case (every login fails token exchange), and that is what this
# fails loudly on.
#
# THIS RUNS ON THE RUNNER, against two values the caller already read. It does
# not itself touch Keycloak or app-ui, for the same reason
# check_deploy_drift.sh does its comparison on the runner rather than the
# host: the decision belongs somewhere that cannot also be the thing drifting.
#
# Usage:
#   check_hill90_ui_secret_agreement.sh <keycloak-secret-sha256> <app-ui-secret-sha256>
#
# Exit codes, following check_deploy_drift.sh's contract:
#   0  AGREE              (both hashes present and equal)
#   1  DISAGREE            (both hashes present, not equal — the outage case)
#   2  CANNOT DETERMINE    (either hash missing/empty — never silent, never green)

set -uo pipefail

KC_HASH="${1:-}"
UI_HASH="${2:-}"

say()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; }

say "hill90-ui secret agreement"
say "=============================================="

if [ -z "$KC_HASH" ] || [ -z "$UI_HASH" ]; then
    fail "CANNOT DETERMINE: one or both secret hashes were not supplied. This is NOT a pass — nothing was compared. keycloak='${KC_HASH:-<empty>}' app-ui='${UI_HASH:-<empty>}'"
    exit 2
fi

say "  keycloak client secret sha256: ${KC_HASH}"
say "  app-ui AUTH_KEYCLOAK_SECRET sha256: ${UI_HASH}"

if [ "$KC_HASH" = "$UI_HASH" ]; then
    say "  AGREE: the Keycloak client and app-ui hold the same secret."
    exit 0
fi

fail "DISAGREE: the Keycloak client secret and app-ui's AUTH_KEYCLOAK_SECRET do NOT match. This is the outage case — every login will fail token exchange until they are reconciled."
exit 1
