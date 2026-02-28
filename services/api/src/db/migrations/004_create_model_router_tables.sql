-- Model router tables for LLM gateway functionality
-- model_catalog: Available models in the system
-- model_policies: Sets of allowed models assignable to agents
-- model_usage: Metadata-only audit log (token counts + cost deferred to Phase 2)
-- model_router_revoked_tokens: Persisted JWT revocations for AI service restart recovery

-- Model catalog: available models in the system
CREATE TABLE IF NOT EXISTS model_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    provider VARCHAR(64) NOT NULL,
    description TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Model policies: named sets of allowed models
CREATE TABLE IF NOT EXISTS model_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    allowed_models JSONB NOT NULL DEFAULT '[]',
    -- Rate limit placeholders for Phase 2 (not enforced in Phase 1)
    max_requests_per_minute INTEGER DEFAULT NULL,
    max_tokens_per_day INTEGER DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Model usage: metadata-only audit log
-- input_tokens, output_tokens, cost_usd columns exist but default to 0 for Phase 2
CREATE TABLE IF NOT EXISTS model_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(64) NOT NULL,
    model_name VARCHAR(128) NOT NULL,
    request_type VARCHAR(32) NOT NULL DEFAULT 'chat.completion',
    status VARCHAR(16) NOT NULL DEFAULT 'success',
    latency_ms INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd NUMERIC(10, 6) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_usage_agent_id ON model_usage (agent_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_created_at ON model_usage (created_at);

-- Revoked JWTs for model-router tokens
CREATE TABLE IF NOT EXISTS model_router_revoked_tokens (
    jti VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(64) NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_router_revoked_tokens_expires_at
    ON model_router_revoked_tokens (expires_at);

-- Seed default model policy with Claude Sonnet and GPT-4o-mini
INSERT INTO model_policies (name, description, allowed_models)
VALUES (
    'default',
    'Default model policy — Claude Sonnet and GPT-4o-mini',
    '["claude-sonnet-4-20250514", "gpt-4o-mini"]'::jsonb
)
ON CONFLICT (name) DO NOTHING;

-- Seed model catalog entries
INSERT INTO model_catalog (name, provider, description) VALUES
    ('claude-sonnet-4-20250514', 'anthropic', 'Claude Sonnet 4 — balanced capability and cost'),
    ('gpt-4o', 'openai', 'GPT-4o — high capability'),
    ('gpt-4o-mini', 'openai', 'GPT-4o Mini — fast and cost-effective')
ON CONFLICT (name) DO NOTHING;
