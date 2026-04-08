-- Migration 048: Create user_preferences table
--
-- Stores per-user UI/platform preferences as JSONB.
-- One row per Keycloak user ID, upserted on PUT.

CREATE TABLE IF NOT EXISTS user_preferences (
  keycloak_id VARCHAR(255) PRIMARY KEY,
  preferences JSONB NOT NULL DEFAULT '{"theme": "dark", "notifications_enabled": true, "sidebar_collapsed": false}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
