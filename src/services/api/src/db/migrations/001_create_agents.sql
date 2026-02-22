CREATE TABLE agents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id      VARCHAR(63) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  tools_config  JSONB NOT NULL DEFAULT '{"shell":{"enabled":false},"filesystem":{"enabled":false},"health":{"enabled":true}}',
  cpus          VARCHAR(10) NOT NULL DEFAULT '1.0',
  mem_limit     VARCHAR(10) NOT NULL DEFAULT '1g',
  pids_limit    INTEGER NOT NULL DEFAULT 200,
  soul_md       TEXT NOT NULL DEFAULT '',
  rules_md      TEXT NOT NULL DEFAULT '',
  status        VARCHAR(20) NOT NULL DEFAULT 'stopped',
  container_id  VARCHAR(64),
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    VARCHAR(255) NOT NULL
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_created_by ON agents(created_by);
