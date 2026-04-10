-- Migration 055: Agent memory journal for context persistence.
--
-- Agents accumulate observations, decisions, and notes across chat sessions.
-- Entries are agent-scoped, ordered by creation time, and readable by
-- the agent at session start to restore context.

CREATE TABLE agent_journal (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  entry_type  VARCHAR(32) NOT NULL DEFAULT 'observation'
              CHECK (entry_type IN ('observation', 'decision', 'plan', 'note', 'error')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_journal_agent ON agent_journal(agent_id, created_at DESC);
