-- Migration 010: Add delegation_id to model_usage for per-child usage attribution.
--
-- Nullable: parent (non-delegated) requests have NULL delegation_id.
-- Partial index covers only delegation rows for efficient per-child queries.

ALTER TABLE model_usage ADD COLUMN delegation_id UUID DEFAULT NULL;

CREATE INDEX idx_model_usage_delegation ON model_usage(delegation_id)
  WHERE delegation_id IS NOT NULL;
