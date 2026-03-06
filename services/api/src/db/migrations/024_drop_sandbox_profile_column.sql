-- Cleanup: remove legacy sandbox_profile column from agents.
-- The profile concept is no longer part of the active Skills model.

ALTER TABLE agents
    DROP COLUMN IF EXISTS sandbox_profile;
