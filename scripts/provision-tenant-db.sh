#!/usr/bin/env bash
# Provision a tenant's databases on the platform's Postgres.
#
# Postgres here is the open-source counterpart to Azure Database for PostgreSQL
# (docs/decisions/platform-primitives.md). A managed database service does not
# bake its tenants into the server image; it exposes a control-plane operation
# that creates a login and some databases. This script is that operation.
#
# That is why nothing here goes into platform/data/postgres/init.sh. That file
# stays platform-only — #495 deleted Postgres partly because application
# databases in the bootstrap made it look like an application dependency, and
# adding a database there still means "a PLATFORM service owns this". It also
# would not work: init.sh runs only on an empty data volume, and production's is
# not empty.
#
# What a tenant gets:
#   - one login role: NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION
#   - the databases it asked for, OWNED by that role, with PUBLIC revoked
#   - the extensions its migrations expect, installed by the platform because a
#     least-privilege role cannot install them itself
#
# What a tenant does not get: any access to a platform database. The default
# `PUBLIC` CONNECT privilege on every existing database is revoked, which is the
# step that makes the boundary real — without it a tenant role can open
# `keycloak` on day one.
#
# Usage:
#   TENANT_DB_PASSWORD=... bash scripts/provision-tenant-db.sh \
#       --role hill90_app [--container postgres] [--extension vector] \
#       [--dry-run] <database> [<database>...]
#
#   TENANT_DB_PASSWORD=... bash scripts/provision-tenant-db.sh --harden-only
#
# The password is read from TENANT_DB_PASSWORD and is never written to disk, to
# this repo's secret store, or to the terminal. The tenant owns its own copy of
# that credential in its own secret store; this platform only sets it. Two stores
# holding the same secret is how the tenant's Keycloak client secret drifted.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

CONTAINER="${CONTAINER_PREFIX:-}postgres"
ADMIN_ROLE="${DB_USER:-hill90}"
TENANT_ROLE=""
EXTENSIONS=()
DATABASES=()
DRY_RUN=0
HARDEN_ONLY=0

# Databases that are never a tenant's, whatever the caller says. `template1` is
# here because it is connectable by default; `template0` because it is a
# database name and mistakes are cheap to prevent.
reserved_dbs() {
    printf '%s\n' postgres template0 template1 keycloak "$ADMIN_ROLE"
}

usage() {
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-1}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --container)   CONTAINER="$2"; shift 2 ;;
        --role)        TENANT_ROLE="$2"; shift 2 ;;
        --admin-role)  ADMIN_ROLE="$2"; shift 2 ;;
        --extension)   EXTENSIONS+=("$2"); shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --harden-only) HARDEN_ONLY=1; shift ;;
        -h|--help)     usage 0 ;;
        -*)            die "unknown option: $1" ;;
        *)             DATABASES+=("$1"); shift ;;
    esac
done

# The app's migrations run `CREATE EXTENSION IF NOT EXISTS` for both of these
# (services/knowledge/app/db/migrations/001 and 011/012 in hill90-app). Neither
# is a trusted extension, so a NOSUPERUSER tenant cannot create them and the
# first migration would fail. The platform installs them; the app's statement
# then finds them present and does nothing.
[[ ${#EXTENSIONS[@]} -eq 0 ]] && EXTENSIONS=("uuid-ossp" "vector")

require_command docker

# ---------------------------------------------------------------------------
# psql plumbing
#
# Reads go through -tAc. Writes go in on stdin, never in argv: `docker exec`
# arguments are visible in `ps` on the host, and the role password is one of
# them.
# ---------------------------------------------------------------------------

psql_read() {
    local db="$1" sql="$2"
    docker exec "$CONTAINER" psql -U "$ADMIN_ROLE" -d "$db" -tAc "$sql" 2>/dev/null | tr -d '\r'
}

psql_exec() {
    local db="$1"
    if [[ $DRY_RUN -eq 1 ]]; then
        sed "s/PASSWORD '[^']*'/PASSWORD '<redacted>'/" | sed "s/^/    [dry-run ${db}] /"
        return 0
    fi
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$ADMIN_ROLE" -d "$db" >/dev/null
}

# Postgres has no CREATE DATABASE ... IF NOT EXISTS and no way to run it inside a
# DO block, so the \gexec trick is the only idempotent form. Same shape as
# platform/data/postgres/init.sh, deliberately.
sql_literal() { printf "%s" "${1//\'/\'\'}"; }
sql_ident()   { printf '"%s"' "${1//\"/\"\"}"; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || die "container '$CONTAINER' is not running"

psql_read postgres "SELECT 1" | grep -q 1 \
    || die "cannot query Postgres in '$CONTAINER' as '$ADMIN_ROLE'"

harden_platform_databases() {
    # The step that makes the boundary real. Every database Postgres creates
    # grants CONNECT to PUBLIC by default, so a tenant role can open the
    # platform's databases the moment it exists. Revoke that, and grant the
    # platform role explicitly rather than leaving it to rely on PUBLIC.
    #
    # Safe for the platform itself: the platform role is a superuser and the
    # owner of these databases, and ACL checks are bypassed for superusers.
    # Verified by the "the platform still works" assertions in
    # scripts/checks/tenant-db-isolation-test.sh.
    info "Revoking the default PUBLIC access on platform databases..."
    local db
    while read -r db; do
        psql_read postgres "SELECT 1 FROM pg_database WHERE datname='$(sql_literal "$db")'" \
            | grep -q 1 || continue
        psql_exec postgres <<-SQL
			REVOKE ALL ON DATABASE $(sql_ident "$db") FROM PUBLIC;
			GRANT ALL ON DATABASE $(sql_ident "$db") TO $(sql_ident "$ADMIN_ROLE");
		SQL
        echo "    hardened: ${db}"
    done < <(reserved_dbs)
}

if [[ $HARDEN_ONLY -eq 1 ]]; then
    [[ ${#DATABASES[@]} -eq 0 ]] || die "--harden-only takes no database arguments"
    harden_platform_databases
    success "Platform databases hardened."
    exit 0
fi

[[ -n "$TENANT_ROLE" ]] || die "--role is required"
[[ ${#DATABASES[@]} -gt 0 ]] || die "at least one database name is required"

[[ "$TENANT_ROLE" =~ ^[a-z][a-z0-9_]{2,62}$ ]] \
    || die "invalid tenant role name '$TENANT_ROLE' (want ^[a-z][a-z0-9_]{2,62}\$)"
[[ "$TENANT_ROLE" != "$ADMIN_ROLE" ]] \
    || die "'$TENANT_ROLE' is the platform's own role. A tenant must never be given it — it is a superuser over the platform's data."

# Refuse to hand a tenant any existing superuser or role-creating login.
existing_attrs=$(psql_read postgres \
    "SELECT rolsuper::text || ' ' || rolcreaterole::text || ' ' || rolcreatedb::text
       FROM pg_roles WHERE rolname = '$(sql_literal "$TENANT_ROLE")'")
if [[ -n "$existing_attrs" && "$existing_attrs" != "false false false" ]]; then
    die "role '$TENANT_ROLE' already exists with elevated attributes (super createrole createdb = $existing_attrs). Refusing to reuse it as a tenant role."
fi

TENANT_DB_PASSWORD="${TENANT_DB_PASSWORD:-}"
[[ -n "$TENANT_DB_PASSWORD" ]] || die "TENANT_DB_PASSWORD is not set"
[[ ${#TENANT_DB_PASSWORD} -ge 16 ]] \
    || die "TENANT_DB_PASSWORD is shorter than 16 characters"
[[ "$TENANT_DB_PASSWORD" != *$'\n'* ]] \
    || die "TENANT_DB_PASSWORD contains a newline"

for db in "${DATABASES[@]}"; do
    [[ "$db" =~ ^[a-z][a-z0-9_]{2,62}$ ]] \
        || die "invalid database name '$db' (want ^[a-z][a-z0-9_]{2,62}\$)"
    if reserved_dbs | grep -qxF "$db"; then
        die "'$db' is a platform database. A tenant database cannot be named that — see docs/decisions/platform-primitives.md."
    fi
    # The dangerous case the name check alone would miss: an existing database
    # owned by the platform role. Changing its owner to a tenant is how you hand
    # over platform data by accident.
    owner=$(psql_read postgres \
        "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$(sql_literal "$db")'")
    if [[ -n "$owner" && "$owner" != "$TENANT_ROLE" ]]; then
        die "database '$db' already exists and is owned by '$owner', not '$TENANT_ROLE'. Refusing to change the owner of an existing database."
    fi
done

# ---------------------------------------------------------------------------
# The tenant login role
# ---------------------------------------------------------------------------

info "Provisioning tenant role '${TENANT_ROLE}' in '${CONTAINER}'..."

# NOINHERIT so a future GRANT of some group role to this one does not silently
# widen it; the tenant would have to SET ROLE explicitly.
ROLE_ATTRS="LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
if [[ -n "$existing_attrs" ]]; then
    psql_exec postgres <<-SQL
		ALTER ROLE $(sql_ident "$TENANT_ROLE") ${ROLE_ATTRS} PASSWORD '$(sql_literal "$TENANT_DB_PASSWORD")';
	SQL
    echo "    role updated (password reset, attributes reasserted)"
else
    psql_exec postgres <<-SQL
		CREATE ROLE $(sql_ident "$TENANT_ROLE") ${ROLE_ATTRS} PASSWORD '$(sql_literal "$TENANT_DB_PASSWORD")';
	SQL
    echo "    role created"
fi

# ---------------------------------------------------------------------------
# The tenant's databases
# ---------------------------------------------------------------------------

for db in "${DATABASES[@]}"; do
    psql_exec postgres <<-SQL
		SELECT 'CREATE DATABASE $(sql_ident "$db") OWNER $(sql_ident "$TENANT_ROLE")'
		WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$(sql_literal "$db")')\gexec
	SQL

    # Only this tenant may open it. Without the REVOKE, every other tenant role
    # on this server could connect via the default PUBLIC grant.
    psql_exec postgres <<-SQL
		REVOKE ALL ON DATABASE $(sql_ident "$db") FROM PUBLIC;
		GRANT ALL ON DATABASE $(sql_ident "$db") TO $(sql_ident "$TENANT_ROLE");
	SQL

    # The database owner is not automatically the owner of its `public` schema.
    # Set it, so the tenant can create objects there without any grant from us.
    psql_exec "$db" <<-SQL
		ALTER SCHEMA public OWNER TO $(sql_ident "$TENANT_ROLE");
	SQL

    for ext in "${EXTENSIONS[@]}"; do
        psql_exec "$db" <<-SQL
			CREATE EXTENSION IF NOT EXISTS $(sql_ident "$ext");
		SQL
    done

    if [[ $DRY_RUN -eq 0 ]]; then
        actual_owner=$(psql_read postgres \
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$(sql_literal "$db")'")
        [[ "$actual_owner" == "$TENANT_ROLE" ]] \
            || die "post-check failed: '$db' is owned by '$actual_owner', expected '$TENANT_ROLE'"
    fi
    echo "    ${db}: owned by ${TENANT_ROLE}, PUBLIC revoked, extensions ${EXTENSIONS[*]}"
done

harden_platform_databases

if [[ $DRY_RUN -eq 1 ]]; then
    warn "Dry run — nothing was changed."
    exit 0
fi

success "Tenant '${TENANT_ROLE}' provisioned: ${DATABASES[*]}"
echo "" >&2
info "The privilege boundary is asserted by:"
info "  bash scripts/checks/tenant-db-isolation-test.sh"
