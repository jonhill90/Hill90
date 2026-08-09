#!/usr/bin/env bash
# Refuse a first Keycloak realm import without a real hill90-ui client secret.
#
# `start --import-realm` ignores existing realms, so HILL90_UI_CLIENT_SECRET is
# legitimately absent on routine auth deploys.  The Keycloak database is the
# authoritative distinction before deploy.sh stops or starts the container:
# no `platform` realm means the next Keycloak start will import it.
#
# The script deliberately reports only state, never the secret value.
# Usage: preflight-first-realm-import-secret.sh <db-user> <db-name> <realm>
set -euo pipefail

DB_USER="${1:?db user required}"
DB_NAME="${2:?db name required}"
REALM="${3:?realm required}"

query() {
    docker exec postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

# A fresh Keycloak database has no realm table.  Once the schema exists, ask
# the database rather than inferring import state from whether a container is
# currently running; routine deploys stop that container themselves.
if ! realm_table_exists=$(query "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'realm');"); then
    echo "ERROR: could not determine whether Keycloak's realm table exists; refusing auth deploy before a possible first import." >&2
    exit 2
fi

realm_exists=f
if [ "$realm_table_exists" = t ]; then
    if ! realm_exists=$(query "SELECT EXISTS (SELECT 1 FROM realm WHERE name = '${REALM}');"); then
        echo "ERROR: could not determine whether realm '${REALM}' exists; refusing auth deploy before a possible first import." >&2
        exit 2
    fi
fi

if [ "$realm_exists" = t ]; then
    echo "Keycloak realm '${REALM}' already exists; routine auth deploy does not need HILL90_UI_CLIENT_SECRET."
    exit 0
fi

secret="${HILL90_UI_CLIENT_SECRET:-}"
if [ -z "$secret" ]; then
    echo "ERROR: HILL90_UI_CLIENT_SECRET is missing; refusing the first Keycloak realm import before it can install a public placeholder." >&2
    exit 1
fi

if [ "$secret" = '${HILL90_UI_CLIENT_SECRET}' ]; then
    echo "ERROR: HILL90_UI_CLIENT_SECRET is the literal placeholder; refusing the first Keycloak realm import." >&2
    exit 1
fi

echo "First Keycloak realm import preflight passed; HILL90_UI_CLIENT_SECRET is present."
