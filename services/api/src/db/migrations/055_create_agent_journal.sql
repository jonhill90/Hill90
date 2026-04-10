-- Agent journal: persistent observations, decisions, and notes across sessions.
CREATE TABLE IF NOT EXISTS agent_journal (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    entry_type VARCHAR(32) NOT NULL DEFAULT 'observation',
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_journal_agent_id ON agent_journal(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_journal_created_at ON agent_journal(created_at DESC);
