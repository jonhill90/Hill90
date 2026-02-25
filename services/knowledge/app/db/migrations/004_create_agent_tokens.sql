-- Agent tokens table — refresh token state for single-use enforcement
CREATE TABLE IF NOT EXISTS agent_tokens (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id      TEXT NOT NULL,
    jti           TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    issued_at     TIMESTAMPTZ NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    rotated_from  UUID REFERENCES agent_tokens(id),
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent
    ON agent_tokens (agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash
    ON agent_tokens (token_hash) WHERE revoked_at IS NULL;
