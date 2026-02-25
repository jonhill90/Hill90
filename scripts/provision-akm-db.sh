#!/usr/bin/env bash
# Provision the hill90_akm database on an existing PostgreSQL instance.
# Run on VPS: bash scripts/provision-akm-db.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

echo "Provisioning hill90_akm database..."

docker exec postgres psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<-'EOSQL'
    SELECT 'CREATE DATABASE hill90_akm'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hill90_akm')\gexec

    \c hill90_akm;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    \c postgres;
    GRANT ALL PRIVILEGES ON DATABASE hill90_akm TO postgres;
EOSQL

echo "✓ hill90_akm database provisioned"
