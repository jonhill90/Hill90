-- Migration 013: Create user_models table
--
-- Stores user-defined models that reference a provider connection.
-- litellm_model holds the provider-prefixed string (e.g., "openai/gpt-4o")
-- that LiteLLM uses for routing. Unique by (name, created_by).

CREATE TABLE IF NOT EXISTS user_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    litellm_model VARCHAR(128) NOT NULL,
    description TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT true,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (name, created_by)
);

CREATE INDEX IF NOT EXISTS idx_user_models_owner
    ON user_models(created_by);

CREATE INDEX IF NOT EXISTS idx_user_models_connection
    ON user_models(connection_id);
