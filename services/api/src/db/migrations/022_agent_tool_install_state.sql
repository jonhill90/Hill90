-- Phase 6B foundation: persistent per-agent tool installation status

CREATE TABLE IF NOT EXISTS agent_tool_installs (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'installed', 'failed')),
    install_message TEXT DEFAULT '',
    installed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (agent_id, tool_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_installs_status ON agent_tool_installs(status);

