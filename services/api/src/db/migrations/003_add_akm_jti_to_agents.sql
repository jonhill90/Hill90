-- Add AKM JWT identifier and expiry columns to agents table for token revocation on stop
ALTER TABLE agents ADD COLUMN IF NOT EXISTS akm_jti VARCHAR(64);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS akm_exp INTEGER;
