-- Migration 040: Add model-router refresh secret hash to agents table.
-- Enables token refresh without agent restart (mirrors AKM refresh pattern).

ALTER TABLE agents ADD COLUMN model_router_refresh_hash VARCHAR(64) DEFAULT NULL;
