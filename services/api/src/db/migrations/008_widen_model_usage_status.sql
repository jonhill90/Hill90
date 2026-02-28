-- Widen model_usage.status from VARCHAR(16) to VARCHAR(32) to accommodate
-- 'client_disconnect' (17 chars) and future status values.
ALTER TABLE model_usage ALTER COLUMN status TYPE VARCHAR(32);
