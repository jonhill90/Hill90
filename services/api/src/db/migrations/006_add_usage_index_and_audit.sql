-- Phase 2: Usage tracking indexes and policy audit column
-- 1. Composite index for rate limit checks (count requests per agent in time window)
-- 2. Audit column for tracking policy changes

CREATE INDEX IF NOT EXISTS idx_model_usage_agent_created
  ON model_usage (agent_id, created_at DESC);

ALTER TABLE model_policies ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64) DEFAULT NULL;
