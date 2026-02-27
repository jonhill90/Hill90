-- Quarantine entries table — reconciler quarantine records
CREATE TABLE IF NOT EXISTS quarantine_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_id        UUID REFERENCES knowledge_entries(id),
    agent_id        TEXT NOT NULL,
    path            TEXT NOT NULL,
    reason          TEXT NOT NULL,
    attempts        INT NOT NULL DEFAULT 0,
    last_error      TEXT,
    quarantined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quarantine_entries_agent
    ON quarantine_entries (agent_id);
