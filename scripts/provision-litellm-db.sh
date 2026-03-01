#!/usr/bin/env bash
# Provision the hill90_litellm database on an existing PostgreSQL instance.
# Run on VPS: bash scripts/provision-litellm-db.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# hill90 is the platform-invariant PostgreSQL superuser, set at VPS bootstrap
# via POSTGRES_USER=hill90 in docker-compose.db.yml.
DB_USER="${DB_USER:-hill90}"

echo "Provisioning hill90_litellm database (user: $DB_USER)..."

docker exec postgres psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname postgres <<-EOSQL
    SELECT 'CREATE DATABASE hill90_litellm'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_litellm')\\gexec

    \\c hill90_litellm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \\c postgres;
    GRANT ALL PRIVILEGES ON DATABASE hill90_litellm TO $DB_USER;
EOSQL

echo "✓ hill90_litellm database provisioned"
