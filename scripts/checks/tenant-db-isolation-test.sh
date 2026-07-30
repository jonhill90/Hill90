#!/usr/bin/env bash
# Integration test: does the tenant privilege boundary on platform Postgres
# actually hold?
#
# This test exists because the obvious way to check a Postgres role — `docker
# exec postgres psql -U role` — proves NOTHING about that role's password or its
# network privileges. The platform's pg_hba.conf is:
#
#     local  all all              trust
#     host   all all 127.0.0.1/32 trust
#     host   all all all          scram-sha-256
#
# The first two lines mean an in-container psql authenticates by trust: it would
# succeed with no password, with the wrong password, and for a role whose
# password was never set. Only a connection arriving over the container network
# hits the scram-sha-256 line. So every assertion here is made from a SECOND
# container, over the network, and never with `docker exec` into the server.
#
# It builds its own throwaway Postgres from the same image and the same platform
# bootstrap the real stack uses, so it never touches a running stack, and asserts
# both halves of the boundary: the tenant role reaches the databases it owns, and
# is refused on the platform's own.
#
# Usage: bash scripts/checks/tenant-db-isolation-test.sh [--keep]
#        --keep   leave the throwaway containers up for inspection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Throwaway names, deliberately unlike anything a stack creates. Nothing here
# may collide with hill90*-* (a running stack) or with another pane's scratch
# containers.
NET="h90tenanttest-net"
# Named "<prefix>postgres" rather than "<prefix>db" so the real health check from
# scripts/local.sh can be pointed at it: that function builds its container name
# as "${cp}postgres". Reusing the actual function is the point — a second copy of
# the classification logic here would pass while the real one rotted.
CP="h90tenanttest-"
PG="${CP}postgres"
IMAGE="pgvector/pgvector:pg16"

PLATFORM_ROLE="hill90"
PLATFORM_PASSWORD="platform-pw-not-a-secret"
TENANT_ROLE="hill90_app"
TENANT_PASSWORD="tenant-pw-not-a-secret-0123456789"
OTHER_TENANT_ROLE="hill90_other"
OTHER_TENANT_PASSWORD="other-pw-not-a-secret-0123456789"

TENANT_DBS=(hill90_api hill90_akm hill90_litellm)
# Every database the tenant role must NOT be able to open. `template1` is in the
# list because it is connectable by default and is nobody's idea of tenant data.
PLATFORM_DBS=(hill90 keycloak postgres template1)

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

pass_count=0
fail_count=0

cleanup() {
    if [ "$KEEP" -eq 1 ]; then
        echo -e "${YELLOW}--keep: leaving ${PG} and ${NET} up.${NC}" >&2
        return
    fi
    docker rm -f "$PG" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fatal() { echo -e "${RED}FATAL: $*${NC}" >&2; exit 2; }

# --------------------------------------------------------------------------
# Assertions. Every one runs psql in a throwaway client container on the same
# docker network, so authentication goes through pg_hba's scram-sha-256 line.
# --------------------------------------------------------------------------

# net_psql ROLE PASSWORD DB SQL -> prints combined output, returns psql's status
net_psql() {
    local role="$1" password="$2" db="$3" sql="$4"
    docker run --rm --network "$NET" -e PGPASSWORD="$password" "$IMAGE" \
        psql -h "$PG" -U "$role" -d "$db" -v ON_ERROR_STOP=1 -tAc "$sql" 2>&1
}

expect_ok() {
    local label="$1" role="$2" password="$3" db="$4" sql="$5" out
    if out=$(net_psql "$role" "$password" "$db" "$sql"); then
        echo -e "  ${GREEN}✓${NC} ${label}"
        pass_count=$((pass_count + 1))
    else
        echo -e "  ${RED}✗${NC} ${label} — expected success, got:"
        echo "$out" | sed 's/^/        /'
        fail_count=$((fail_count + 1))
    fi
}

# expect_refused LABEL ROLE PASSWORD DB SQL EXPECTED_SUBSTRING
# Fails if the command succeeds, and also fails if it is refused for the wrong
# reason — "connection refused" is not "permission denied", and a test that
# accepts either would pass against a Postgres that is merely down.
expect_refused() {
    local label="$1" role="$2" password="$3" db="$4" sql="$5" expect="$6" out
    if out=$(net_psql "$role" "$password" "$db" "$sql"); then
        echo -e "  ${RED}✗${NC} ${label} — expected refusal, but it SUCCEEDED: ${out}"
        fail_count=$((fail_count + 1))
    elif echo "$out" | grep -qiF "$expect"; then
        echo -e "  ${GREEN}✓${NC} ${label}"
        pass_count=$((pass_count + 1))
    else
        echo -e "  ${RED}✗${NC} ${label} — refused, but not for the expected reason"
        echo "        expected to contain: ${expect}"
        echo "$out" | sed 's/^/        got: /'
        fail_count=$((fail_count + 1))
    fi
}

expect_equals() {
    local label="$1" role="$2" password="$3" db="$4" sql="$5" want="$6" out
    out=$(net_psql "$role" "$password" "$db" "$sql" || true)
    if [ "$(echo "$out" | tr -d '[:space:]')" = "$want" ]; then
        echo -e "  ${GREEN}✓${NC} ${label}"
        pass_count=$((pass_count + 1))
    else
        echo -e "  ${RED}✗${NC} ${label} — wanted '${want}', got '${out}'"
        fail_count=$((fail_count + 1))
    fi
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || fatal "docker is not available"
docker info >/dev/null 2>&1 || fatal "docker daemon is not reachable"

INIT_SH="$PROJECT_ROOT/platform/data/postgres/init.sh"
[ -f "$INIT_SH" ] || fatal "platform bootstrap not found: $INIT_SH"

PROVISIONER="$PROJECT_ROOT/scripts/provision-tenant-db.sh"

echo -e "${BOLD}Tenant database isolation on platform Postgres${NC}"
echo ""

cleanup
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
    -e POSTGRES_USER="$PLATFORM_ROLE" \
    -e POSTGRES_PASSWORD="$PLATFORM_PASSWORD" \
    -e POSTGRES_DB="$PLATFORM_ROLE" \
    -v "$INIT_SH:/docker-entrypoint-initdb.d/init.sh:ro" \
    "$IMAGE" >/dev/null

echo "  waiting for the throwaway Postgres to accept connections..."
# -h 127.0.0.1, not the Unix socket. The image's entrypoint runs the bootstrap
# against a temporary server with listen_addresses='' and then shuts it down, so
# a socket-based pg_isready goes green *during* init and then the server
# disappears underneath the test. Only TCP proves the real server is up.
pg_ready() { docker exec "$PG" pg_isready -h 127.0.0.1 -U "$PLATFORM_ROLE" >/dev/null 2>&1; }
for _ in $(seq 1 90); do
    pg_ready && break
    sleep 1
done
pg_ready || fatal "throwaway Postgres never became ready: $(docker logs "$PG" 2>&1 | tail -20)"

# Sanity-check the fixture itself: the platform bootstrap must NOT have created
# the tenant databases. If it did, this test would be proving the wrong thing.
for db in "${TENANT_DBS[@]}"; do
    if docker exec "$PG" psql -U "$PLATFORM_ROLE" -tAc \
        "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
        fatal "fixture is wrong: the platform bootstrap created ${db}. Platform bootstrap must stay platform-only (#495)."
    fi
done
echo -e "  ${GREEN}✓${NC} fixture: platform bootstrap created no tenant databases"
echo ""

# --------------------------------------------------------------------------
# The thing under test
# --------------------------------------------------------------------------

echo -e "${BOLD}Provisioning${NC}"
[ -x "$PROVISIONER" ] || [ -f "$PROVISIONER" ] \
    || fatal "provisioner not found: $PROVISIONER"

TENANT_DB_PASSWORD="$TENANT_PASSWORD" bash "$PROVISIONER" \
    --container "$PG" --role "$TENANT_ROLE" "${TENANT_DBS[@]}" \
    || fatal "provisioner failed"

# A second tenant, so cross-tenant isolation is tested and not assumed.
TENANT_DB_PASSWORD="$OTHER_TENANT_PASSWORD" bash "$PROVISIONER" \
    --container "$PG" --role "$OTHER_TENANT_ROLE" other_probe \
    || fatal "provisioner failed for the second tenant"
echo ""

# --------------------------------------------------------------------------
# Half one: the tenant reaches what it owns
# --------------------------------------------------------------------------

echo -e "${BOLD}The tenant role reaches its own databases (over the network)${NC}"
for db in "${TENANT_DBS[@]}"; do
    expect_ok "connect and query ${db}" \
        "$TENANT_ROLE" "$TENANT_PASSWORD" "$db" "SELECT 1"
done
for db in "${TENANT_DBS[@]}"; do
    expect_ok "create and drop a table in ${db}" \
        "$TENANT_ROLE" "$TENANT_PASSWORD" "$db" \
        "CREATE TABLE isolation_probe (id int); DROP TABLE isolation_probe"
done
# The app's own migrations run CREATE EXTENSION (uuid-ossp, vector). A
# least-privilege tenant cannot install an extension, so the platform must have
# installed them already or the app breaks on first migration.
for db in "${TENANT_DBS[@]}"; do
    expect_equals "uuid-ossp and vector are present in ${db}" \
        "$TENANT_ROLE" "$TENANT_PASSWORD" "$db" \
        "SELECT count(*) FROM pg_extension WHERE extname IN ('uuid-ossp','vector')" \
        "2"
done
echo ""

# --------------------------------------------------------------------------
# Half two: the tenant is refused where it must be
# --------------------------------------------------------------------------

echo -e "${BOLD}The tenant role is refused on platform databases${NC}"
for db in "${PLATFORM_DBS[@]}"; do
    expect_refused "cannot connect to ${db}" \
        "$TENANT_ROLE" "$TENANT_PASSWORD" "$db" "SELECT 1" \
        "permission denied for database"
done
echo ""

echo -e "${BOLD}The tenant role has no platform-level power${NC}"
expect_refused "cannot create a database" \
    "$TENANT_ROLE" "$TENANT_PASSWORD" "${TENANT_DBS[0]}" \
    "CREATE DATABASE should_not_exist" "permission denied to create database"
expect_refused "cannot create a role" \
    "$TENANT_ROLE" "$TENANT_PASSWORD" "${TENANT_DBS[0]}" \
    "CREATE ROLE should_not_exist LOGIN" "permission denied to create role"
expect_refused "cannot read pg_authid (other roles' password hashes)" \
    "$TENANT_ROLE" "$TENANT_PASSWORD" "${TENANT_DBS[0]}" \
    "SELECT rolname FROM pg_authid" "permission denied for table pg_authid"
expect_equals "is not a superuser" \
    "$TENANT_ROLE" "$TENANT_PASSWORD" "${TENANT_DBS[0]}" \
    "SELECT usesuper FROM pg_user WHERE usename = current_user" "f"
echo ""

echo -e "${BOLD}Authentication is real, not trust${NC}"
# If this passes with the wrong password, pg_hba has been loosened and every
# other assertion in this file is worthless.
expect_refused "the wrong password is rejected over the network" \
    "$TENANT_ROLE" "wrong-password" "${TENANT_DBS[0]}" "SELECT 1" \
    "password authentication failed"
echo ""

echo -e "${BOLD}Tenants are isolated from each other${NC}"
for db in "${TENANT_DBS[@]}"; do
    expect_refused "a second tenant cannot connect to ${db}" \
        "$OTHER_TENANT_ROLE" "$OTHER_TENANT_PASSWORD" "$db" "SELECT 1" \
        "permission denied for database"
done
expect_refused "the first tenant cannot connect to the second tenant's database" \
    "$TENANT_ROLE" "$TENANT_PASSWORD" "other_probe" "SELECT 1" \
    "permission denied for database"
echo ""

# --------------------------------------------------------------------------
# The boundary must not have broken the platform
# --------------------------------------------------------------------------

echo -e "${BOLD}The platform still works${NC}"
for db in hill90 keycloak postgres; do
    expect_ok "the platform role still reaches ${db} over the network" \
        "$PLATFORM_ROLE" "$PLATFORM_PASSWORD" "$db" "SELECT 1"
done
expect_ok "keycloak's uuid-ossp extension is intact" \
    "$PLATFORM_ROLE" "$PLATFORM_PASSWORD" keycloak \
    "SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'"
echo ""

# --------------------------------------------------------------------------
# Idempotence — this will be run again on a Postgres that already has tenants
# --------------------------------------------------------------------------

echo -e "${BOLD}Re-running the provisioner is safe${NC}"
if TENANT_DB_PASSWORD="$TENANT_PASSWORD" bash "$PROVISIONER" \
    --container "$PG" --role "$TENANT_ROLE" "${TENANT_DBS[@]}" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} second run succeeds"
    pass_count=$((pass_count + 1))
else
    echo -e "  ${RED}✗${NC} second run failed — the provisioner is not idempotent"
    fail_count=$((fail_count + 1))
fi
expect_ok "the tenant still reaches its database after a re-run" \
    "$TENANT_ROLE" "$TENANT_PASSWORD" "${TENANT_DBS[0]}" "SELECT 1"

# The guard that matters most: the provisioner must refuse to touch a platform
# database even when told to.
echo ""
echo -e "${BOLD}The provisioner refuses to provision a platform database${NC}"
for db in keycloak postgres hill90; do
    if TENANT_DB_PASSWORD="$TENANT_PASSWORD" bash "$PROVISIONER" \
        --container "$PG" --role "$TENANT_ROLE" "$db" >/dev/null 2>&1; then
        echo -e "  ${RED}✗${NC} it accepted '${db}' as a tenant database"
        fail_count=$((fail_count + 1))
    else
        echo -e "  ${GREEN}✓${NC} refuses '${db}'"
        pass_count=$((pass_count + 1))
    fi
done
# And it must refuse to hand a tenant the platform's own login role.
if TENANT_DB_PASSWORD="$TENANT_PASSWORD" bash "$PROVISIONER" \
    --container "$PG" --role "$PLATFORM_ROLE" tenant_probe >/dev/null 2>&1; then
    echo -e "  ${RED}✗${NC} it accepted the platform role '${PLATFORM_ROLE}' as a tenant role"
    fail_count=$((fail_count + 1))
else
    echo -e "  ${GREEN}✓${NC} refuses the platform's own role as a tenant role"
    pass_count=$((pass_count + 1))
fi

# --------------------------------------------------------------------------
# The health check itself, against the real tenant database names.
#
# Everything above proves the BOUNDARY. This proves the CHECK that is supposed to
# notice when the boundary breaks — which is a different thing, and the one that
# fails silently. A check that stopped looking still prints a green tick.
#
# It runs the actual check_tenant_db_isolation from scripts/local.sh, not a copy,
# in a subshell so local.sh's own `set -euo pipefail` cannot alter this script's
# error handling.
# --------------------------------------------------------------------------

echo ""
echo -e "${BOLD}The health check notices when the boundary breaks${NC}"

LOCAL_SH_NOMAIN="$(mktemp -t local-nomain.XXXXXX)"
# Strip the trailing `main "$@"` so sourcing defines the functions without
# dispatching a command.
sed '$d' "$PROJECT_ROOT/scripts/local.sh" > "$LOCAL_SH_NOMAIN"
trap 'rm -f "$LOCAL_SH_NOMAIN"; cleanup' EXIT

# run_check -> prints the check's output, returns its exit status
run_check() {
    bash -c "CONTAINER_PREFIX='$CP'; source '$LOCAL_SH_NOMAIN' >/dev/null 2>&1; check_tenant_db_isolation '$CP'" 2>&1
}

admin_sql() { docker exec "$PG" psql -U "$PLATFORM_ROLE" -q -c "$1" >/dev/null 2>&1; }

# expect_check STATUS LABEL EXPECTED_SUBSTRING
expect_check() {
    local want="$1" label="$2" expect="$3" out status
    out=$(run_check) && status=0 || status=1
    if [ "$status" != "$want" ]; then
        echo -e "  ${RED}✗${NC} ${label} — check exited ${status}, wanted ${want}"
        echo "$out" | sed 's/^/        /'
        fail_count=$((fail_count + 1))
        return
    fi
    if ! echo "$out" | grep -qF "$expect"; then
        echo -e "  ${RED}✗${NC} ${label} — exit ${status} was right but the message was not"
        echo "        expected to contain: ${expect}"
        echo "$out" | sed 's/^/        got: /'
        fail_count=$((fail_count + 1))
        return
    fi
    echo -e "  ${GREEN}✓${NC} ${label}"
    pass_count=$((pass_count + 1))
}

# The healthy state must pass, and must NAME the databases it accepted. A check
# that prints a bare tick cannot be distinguished from one that found nothing.
expect_check 0 "passes on the real tenant database list, and names them" \
    "hill90_akm(hill90_app) hill90_api(hill90_app) hill90_litellm(hill90_app)"

# Failure 1: the #495 drift — an application database owned by the platform role.
admin_sql "CREATE DATABASE drift_probe"
expect_check 1 "fails on an application database owned by the platform role" \
    "is owned by the platform role"
admin_sql "DROP DATABASE drift_probe"

# Failure 2: a tenant database opened to PUBLIC, so any other tenant can open it.
admin_sql "GRANT CONNECT ON DATABASE hill90_akm TO PUBLIC"
expect_check 1 "fails when a tenant database grants CONNECT to PUBLIC" \
    "grants CONNECT to PUBLIC"
admin_sql "REVOKE CONNECT ON DATABASE hill90_akm FROM PUBLIC"

# Failure 3: a platform database left open to PUBLIC while a tenant exists. This
# is the one a FUTURE platform database would trip, since Postgres grants
# CONNECT to PUBLIC on every new database by default.
admin_sql "GRANT CONNECT ON DATABASE keycloak TO PUBLIC"
expect_check 1 "fails when a platform database still grants CONNECT to PUBLIC" \
    "still grant CONNECT to PUBLIC"
admin_sql "REVOKE CONNECT ON DATABASE keycloak FROM PUBLIC"

# Failure 4: a tenant database owned by a superuser. Ownership alone is not
# enough — the owner must be unprivileged.
admin_sql "CREATE ROLE super_tenant LOGIN SUPERUSER PASSWORD 'irrelevant-for-this-check'"
admin_sql "CREATE DATABASE super_probe OWNER super_tenant"
admin_sql "REVOKE ALL ON DATABASE super_probe FROM PUBLIC"
expect_check 1 "fails on a tenant database owned by a SUPERUSER" \
    "which is a SUPERUSER"
admin_sql "DROP DATABASE super_probe"
admin_sql "DROP ROLE super_tenant"

# And back to green, so a failure above cannot be mistaken for permanent damage
# to the fixture.
expect_check 0 "returns to passing once every probe is reverted" \
    "hill90_akm(hill90_app) hill90_api(hill90_app) hill90_litellm(hill90_app)"

# --------------------------------------------------------------------------

echo ""
if [ "$fail_count" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All ${pass_count} assertions passed.${NC}"
    exit 0
fi
echo -e "${RED}${BOLD}${fail_count} assertion(s) failed, ${pass_count} passed.${NC}"
exit 1
