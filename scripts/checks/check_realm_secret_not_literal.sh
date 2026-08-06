#!/usr/bin/env bash
# Assert that after a realm import, no Keycloak client secret is an
# unsubstituted ${...} placeholder OR EMPTY — h#835, hardened by h#849.
#
# THE FAILURE THIS CATCHES: platform-realm.json declares hill90-vault's and
# hill90-ui's secrets as ${VAULT_OIDC_CLIENT_SECRET} / ${HILL90_UI_CLIENT_SECRET}.
# `start --import-realm` substitutes them from the container's environment.
# VAULT_OIDC_CLIENT_SECRET is guarded at the compose level (${VAR:?...}), so a
# deploy with it unset refuses before Keycloak ever starts. HILL90_UI_CLIENT_SECRET
# is deliberately NOT guarded there (fad9fefa) — it is legitimately unset on
# every routine `auth` deploy after the first import, and a compose-level guard
# would refuse every one of those. So an import that runs with it unset (a VPS
# rebuild, specifically) succeeds silently, and the resulting client secret for
# hill90-ui — the client fronting hill90.com — is the literal, unsubstituted
# string "${HILL90_UI_CLIENT_SECRET}". This repository is public, so that exact
# string is readable in platform-realm.json by anyone, without needing to guess it.
#
# h#849: the FIRST version of this script queried each client's secret via the
# /client-secret sub-endpoint in CSV form and treated ANY empty result as "no
# secret, skip" — including HILL90_UI_CLIENT_SECRET="" (set but EMPTY, not
# unset), which produces exit 0 with EMPTY output from that endpoint,
# byte-identical to a client that genuinely has no secret credential at all
# (broker, hill90-api, realm-management — verified live). The check ran
# against the exact case its own message claimed to cover ("unset OR EMPTY")
# and returned PASS.
#
# FIXED by querying the client LIST once, in JSON, and using PRESENCE of the
# `secret` key — not its value — as the discriminator. Verified live: clients
# Keycloak never assigned a secret to have NO `secret` key in their JSON at
# all; clients platform-realm.json explicitly gives a `secret` field to
# always have the key, whether its value is real, empty, or a literal
# placeholder. Key-presence distinguishes "nothing to check" from "something
# to check that turned out empty" — value-emptiness cannot, because both look
# identical.
#
# WHY THIS IS NOT check_env_surface.py'S JOB: that check already guarantees (its
# rule 4) that HILL90_UI_CLIENT_SECRET carries no non-empty compose default, which
# stops a KNOWN bad value from ever being configured as a silent fallback. It is a
# static check of the compose YAML text. It cannot see what THIS script checks:
# Keycloak's own import-time substitution behavior when the variable is genuinely
# absent OR empty, which only exists once a real import has actually run. That is
# why this has to ask a live realm, not read the template file — platform-realm.json
# always contains the literal ${...} placeholder, correctly, and always will.
#
# WHY THIS IS SCOPED THE WAY IT IS, DELIBERATELY NARROW: this checks exactly two
# shapes on a client secret after import — a ${...}-looking literal, and an empty
# value — not a general realm validator. It generalises to any future templated
# secret field without being rewritten, but it does not grow into checking
# anything else about the realm.
#
# "CANNOT DETERMINE" IS NOT "PASS": an unreachable Keycloak, a failed admin login,
# a failed client-list query, or a realm with no confidential-and-secret-bearing
# client at all must never read as "no problem found" — each is its own distinct
# outcome. An empty query result silently passing as clean is the exact trap this
# repo has already named once (h#736/h#758's shape, applied here to a query result
# instead of a check-invocation record).
#
# Usage:
#   check_realm_secret_not_literal.sh <container> <realm> <admin-user> <admin-password>
#
# Exit codes:
#   0  PASS               every confidential client's secret is real: non-empty, not a ${...} literal
#   1  PROBLEM FOUND       at least one client secret is empty OR an unsubstituted ${...} literal
#   2  CANNOT DETERMINE    Keycloak unreachable, admin auth failed, the client-list query failed, or no confidential client has a secret key at all
set -uo pipefail

# argv-ok: this script's admin-password argument is only ever a disposable
# throwaway credential for a container the CALLER creates and destroys (see
# realm-secret-substitution-test.sh) — never a real one. Production reuses
# keycloak.sh's own already-authenticated kc() session instead of calling
# this script at all (verify_realm_secrets_substituted, wired into
# cmd_apply), for exactly the reason kc_login itself passes the real admin
# password through the environment rather than argv.
CONTAINER="${1:?Usage: check_realm_secret_not_literal.sh <container> <realm> <admin-user> <admin-password>}"
REALM="${2:?realm required}"
ADMIN_USER="${3:?admin user required}"
ADMIN_PW="${4:?admin password required}"

say()  { printf '%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; }

kc() { docker exec "$CONTAINER" /opt/keycloak/bin/kcadm.sh "$@" 2>&1; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    fail "CANNOT DETERMINE: container '${CONTAINER}' does not exist — Keycloak is unreachable, not proven clean."
    exit 2
fi

# argv-ok: caller-supplied credentials for a container this script does not
# create or own; same pattern as realm-tenant-serves-test.sh's own kcadm login.
if ! kc config credentials --server http://127.0.0.1:8080 --realm master \
       --user "$ADMIN_USER" --password "$ADMIN_PW" >/dev/null 2>&1; then
    fail "CANNOT DETERMINE: kcadm admin login failed against '${CONTAINER}' — cannot query client secrets, not proven clean."
    exit 2
fi

say "Checking every confidential client's secret in realm '${REALM}' for empty or unsubstituted \${...} values"

CLIENTS_JSON=""
if ! CLIENTS_JSON=$(kc get clients -r "$REALM" 2>/dev/null); then
    fail "CANNOT DETERMINE: the client list query for realm '${REALM}' failed. Not proven clean."
    exit 2
fi

CLASSIFICATION=""
if CLASSIFICATION=$(CLIENTS_JSON="$CLIENTS_JSON" python3 <<'PYEOF'
import sys, json, os, re

PLACEHOLDER_RE = re.compile(r'^\$\{[A-Za-z0-9_]+\}$')

try:
    clients = json.loads(os.environ["CLIENTS_JSON"])
except Exception as e:
    print(f"CANNOT_DETERMINE unparseable JSON: {e}")
    sys.exit(3)

if not isinstance(clients, list):
    print("CANNOT_DETERMINE client list was not a JSON array")
    sys.exit(3)

checked = 0
lines = []
failed = False
for c in clients:
    if c.get("publicClient") is True:
        continue
    if "secret" not in c:
        print(f"  {c.get('clientId')}: confidential, no secret key at all — skipped (not a substitution failure)", file=sys.stderr)
        continue
    checked += 1
    value = c.get("secret")
    client_id = c.get("clientId")
    if not value:
        lines.append(f"EMPTY {client_id}")
        failed = True
    elif PLACEHOLDER_RE.match(value):
        lines.append(f"PLACEHOLDER {client_id} {value}")
        failed = True
    else:
        print(f"  {client_id}: secret substituted (not empty, not a literal placeholder)", file=sys.stderr)

if checked == 0:
    print("CANNOT_DETERMINE no confidential client has a secret key at all")
    sys.exit(3)

if failed:
    for line in lines:
        print(line)
    sys.exit(1)

print(f"PASS {checked}")
sys.exit(0)
PYEOF
); then
    PY_STATUS=0
else
    PY_STATUS=$?
fi

if [ "$PY_STATUS" -eq 3 ]; then
    fail "CANNOT DETERMINE: ${CLASSIFICATION#CANNOT_DETERMINE }. Not proven clean."
    exit 2
fi

if [ "$PY_STATUS" -eq 1 ]; then
    found=0
    while IFS=' ' read -r kind client_id detail; do
        [ -n "$kind" ] || continue
        found=1
        if [ "$kind" = "EMPTY" ]; then
            fail "EMPTY SECRET: client '${client_id}' secret is empty — the import ran with the backing variable set but EMPTY. A confidential client with an empty secret is a broken auth state, not a substitution success."
        else
            fail "PLACEHOLDER FOUND: client '${client_id}' secret is the literal unsubstituted string '${detail}' — the import ran with the backing variable unset, and the client secret is now a public template value."
        fi
    done <<< "$CLASSIFICATION"
    [ "$found" -eq 1 ] || fail "CANNOT DETERMINE: a problem was reported but no line could be parsed from it: ${CLASSIFICATION}"
    exit 1
fi

checked_count="${CLASSIFICATION#PASS }"
say "PASS: checked ${checked_count} confidential client secret(s) in realm '${REALM}' — none empty, none an unsubstituted \${...} literal."
exit 0
