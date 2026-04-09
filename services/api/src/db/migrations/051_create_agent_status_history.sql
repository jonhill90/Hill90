-- Track agent status transitions for audit and debugging
CREATE TABLE IF NOT EXISTS agent_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_status_history_agent_id ON agent_status_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_status_history_changed_at ON agent_status_history(changed_at);
