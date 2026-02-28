-- Migration 009: Create model_delegations table for delegated subagent narrowing.
--
-- A delegation binds a child JWT to a restricted subset of the parent's permissions.
-- The child JWT is signed by the API service and carries delegation_id + parent_jti claims.
-- Parent revocation cascades: if parent_jti is revoked, all children fail auth.

CREATE TABLE model_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_agent_id VARCHAR(128) NOT NULL,
  parent_jti VARCHAR(128) NOT NULL,
  child_jti VARCHAR(128) NOT NULL UNIQUE,
  child_label VARCHAR(128) NOT NULL,
  allowed_models JSONB NOT NULL,
  max_requests_per_minute INT DEFAULT NULL,
  max_tokens_per_day INT DEFAULT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_delegations_parent ON model_delegations(parent_agent_id);
CREATE INDEX idx_delegations_child_jti ON model_delegations(child_jti);
