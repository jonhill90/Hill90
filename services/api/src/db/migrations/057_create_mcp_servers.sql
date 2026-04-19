-- MCP server registry and per-agent assignments.
-- Users define MCP servers (stdio, SSE, or HTTP transport),
-- then assign them to agents like skills.

CREATE TABLE IF NOT EXISTS mcp_servers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) NOT NULL,
    description     TEXT,
    transport       VARCHAR(16) NOT NULL DEFAULT 'stdio',
    connection_config JSONB NOT NULL DEFAULT '{}',
    is_platform     BOOLEAN NOT NULL DEFAULT false,
    created_by      VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    mcp_server_id   UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    config_overrides JSONB NOT NULL DEFAULT '{}',
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, mcp_server_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_created_by ON mcp_servers(created_by);
CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_agent ON agent_mcp_servers(agent_id);
