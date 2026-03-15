-- Migration 034: Add routing config, model type, capability, and icon fields
-- Supports router models spanning multiple provider models.
--
-- model_type: 'single' (one connection + one provider model) or 'router' (routing_config)
-- detected_type: auto-detected from model ID (chat, embedding, audio, image, transcription)
-- capabilities: auto-detected feature list
-- routing_config: JSONB with strategy, default_route, and routes array
-- icon_emoji/icon_url: optional user-chosen model icon

ALTER TABLE user_models ADD COLUMN model_type VARCHAR(16) NOT NULL DEFAULT 'single';
ALTER TABLE user_models ADD COLUMN detected_type VARCHAR(32) DEFAULT 'chat';
ALTER TABLE user_models ADD COLUMN capabilities TEXT[] DEFAULT '{}';
ALTER TABLE user_models ADD COLUMN routing_config JSONB DEFAULT NULL;
ALTER TABLE user_models ADD COLUMN icon_emoji VARCHAR(8) DEFAULT NULL;
ALTER TABLE user_models ADD COLUMN icon_url VARCHAR(512) DEFAULT NULL;

-- Allow connection_id and litellm_model to be NULL for router models
ALTER TABLE user_models ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE user_models ALTER COLUMN litellm_model DROP NOT NULL;

-- Enforce mutual exclusivity: single models need connection+litellm_model,
-- router models need routing_config (and must NOT have connection/litellm_model)
ALTER TABLE user_models ADD CONSTRAINT chk_model_type_fields CHECK (
  (model_type = 'single' AND connection_id IS NOT NULL AND litellm_model IS NOT NULL AND routing_config IS NULL)
  OR
  (model_type = 'router' AND connection_id IS NULL AND litellm_model IS NULL AND routing_config IS NOT NULL)
);
