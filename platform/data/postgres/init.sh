#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v db_user="$POSTGRES_USER" <<-'EOSQL'
    SELECT 'CREATE DATABASE keycloak'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec

    SELECT 'CREATE DATABASE hill90_api'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_api')\gexec

    SELECT 'CREATE DATABASE hill90_akm'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_akm')\gexec

    SELECT 'CREATE DATABASE hill90_litellm'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_litellm')\gexec

    \c keycloak;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c hill90_api;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c hill90_akm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c hill90_litellm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c postgres;
    GRANT ALL PRIVILEGES ON DATABASE keycloak TO :"db_user";
    GRANT ALL PRIVILEGES ON DATABASE hill90_api TO :"db_user";
    GRANT ALL PRIVILEGES ON DATABASE hill90_akm TO :"db_user";
    GRANT ALL PRIVILEGES ON DATABASE hill90_litellm TO :"db_user";
EOSQL
