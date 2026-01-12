-- PostgreSQL Initialization Script for Hill90
-- This script runs when the database container is first created

-- Create databases
CREATE DATABASE hill90_auth;
CREATE DATABASE hill90_api;

-- Create users (passwords should come from environment variables)
-- Handled by Docker environment variables:
-- POSTGRES_USER, POSTGRES_PASSWORD

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

\c hill90_auth;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

\c hill90_api;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant privileges
\c postgres;
GRANT ALL PRIVILEGES ON DATABASE hill90_auth TO ${POSTGRES_USER};
GRANT ALL PRIVILEGES ON DATABASE hill90_api TO ${POSTGRES_USER};
