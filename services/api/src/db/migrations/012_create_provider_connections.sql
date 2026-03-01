-- Migration 012: Create provider_connections table
--
-- Stores user-owned provider credentials for BYOK (Bring Your Own Key).
-- API keys are encrypted with AES-256-GCM before storage.
-- Each user can have multiple connections, unique by (name, created_by).

CREATE TABLE IF NOT EXISTS provider_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    api_key_encrypted BYTEA NOT NULL,
    api_key_nonce BYTEA NOT NULL,
    api_base_url VARCHAR(512) DEFAULT NULL,
    is_valid BOOLEAN DEFAULT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (name, created_by)
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_owner
    ON provider_connections(created_by);
