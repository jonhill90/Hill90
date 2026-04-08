-- Agent event webhooks
CREATE TABLE IF NOT EXISTS agent_webhooks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    events      TEXT[] NOT NULL DEFAULT ARRAY['start', 'stop', 'error'],
    secret      VARCHAR(128),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent ON agent_webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_webhooks_active ON agent_webhooks(agent_id, active) WHERE active = TRUE;
