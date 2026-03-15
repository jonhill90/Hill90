-- Migration 033: Add resolution chain columns to model_usage
--
-- requested_model: the model name from the original HTTP request body (pre-alias)
-- provider_model_id: the litellm_model sent to the provider (post-BYOK resolution)
-- Both nullable — pre-AI-121 rows and denial-path rows will have NULLs.

ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS requested_model VARCHAR(128);
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS provider_model_id VARCHAR(128);
