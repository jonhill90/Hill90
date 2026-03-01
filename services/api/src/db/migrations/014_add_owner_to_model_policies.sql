-- Migration 014: Add created_by to model_policies for user-scoped policies
--
-- Existing platform policies have created_by = NULL (admin-managed).
-- User-created policies store the Keycloak sub as created_by.
-- The unique constraint uses COALESCE so two users can each have
-- a policy named "my-policy" without conflict, while platform
-- policies (NULL owner) remain globally unique by name.

ALTER TABLE model_policies ADD COLUMN IF NOT EXISTS created_by VARCHAR(255) DEFAULT NULL;

ALTER TABLE model_policies DROP CONSTRAINT IF EXISTS model_policies_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_policies_name_owner
    ON model_policies (name, COALESCE(created_by, '__platform__'));

CREATE INDEX IF NOT EXISTS idx_model_policies_owner
    ON model_policies(created_by)
    WHERE created_by IS NOT NULL;
