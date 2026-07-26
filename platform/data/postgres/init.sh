#!/bin/bash
# Postgres bootstrap — PLATFORM databases only.
#
# Postgres is a platform primitive here, the open-source counterpart to Azure
# Database for PostgreSQL. See docs/decisions/platform-primitives.md.
#
# It creates only databases that platform services own. The previous version of
# this file also created hill90_api, hill90_akm and hill90_litellm — application
# databases — which is a large part of why Postgres looked like an application
# dependency and was deleted in #495. Application databases belong with the
# application, in the hill90-app repository, and are created by that stack.
#
# Adding a database here is a statement that a PLATFORM service owns it.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v db_user="$POSTGRES_USER" <<-'EOSQL'
    -- Keycloak: the identity provider's own store.
    SELECT 'CREATE DATABASE keycloak'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec

    \c keycloak;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c postgres;
    GRANT ALL PRIVILEGES ON DATABASE keycloak TO :"db_user";
EOSQL

echo "Platform databases ready: keycloak"
