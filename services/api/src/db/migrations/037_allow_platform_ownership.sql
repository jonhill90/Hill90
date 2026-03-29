-- Migration 037: Allow platform-owned provider connections and user models
-- Platform rows have created_by IS NULL (same pattern as model_policies).
-- Admins manage platform connections/models; all users can read/use them.

-- 1. provider_connections: allow NULL created_by
ALTER TABLE provider_connections ALTER COLUMN created_by DROP NOT NULL;

-- Update unique constraint to handle NULL owner (platform = '__platform__' sentinel)
ALTER TABLE provider_connections DROP CONSTRAINT IF EXISTS provider_connections_name_created_by_key;
CREATE UNIQUE INDEX provider_connections_name_owner_unique
  ON provider_connections (name, COALESCE(created_by, '__platform__'));

-- 2. user_models: allow NULL created_by
ALTER TABLE user_models ALTER COLUMN created_by DROP NOT NULL;

-- Update unique constraint to handle NULL owner
ALTER TABLE user_models DROP CONSTRAINT IF EXISTS user_models_name_created_by_key;
CREATE UNIQUE INDEX user_models_name_owner_unique
  ON user_models (name, COALESCE(created_by, '__platform__'));
