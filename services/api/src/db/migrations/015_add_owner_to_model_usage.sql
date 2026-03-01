-- Migration 015: Add owner column to model_usage for durable usage attribution
--
-- The owner column records who owned the agent when the request was made.
-- This is intentionally denormalized — joining to agents.created_by is
-- fragile (agent deletion hides usage, ownership transfer shifts history).
-- Pre-Phase 5 rows keep owner = NULL (platform-key usage, admin-visible only).

ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS owner VARCHAR(255) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_model_usage_owner
    ON model_usage(owner)
    WHERE owner IS NOT NULL;
