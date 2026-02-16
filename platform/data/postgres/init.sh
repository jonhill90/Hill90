#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE keycloak;
    CREATE DATABASE hill90_api;

    \c keycloak;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c hill90_api;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c postgres;
    GRANT ALL PRIVILEGES ON DATABASE keycloak TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON DATABASE hill90_api TO $POSTGRES_USER;
EOSQL
