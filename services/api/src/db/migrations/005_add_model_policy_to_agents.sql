-- Add model-router columns to agents table
-- model_policy_id: FK to model_policies for authorization
-- model_router_jti: JWT ID for token revocation on stop
-- model_router_exp: JWT expiry for revocation timing

ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_policy_id UUID REFERENCES model_policies(id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_router_jti VARCHAR(64);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_router_exp INTEGER;
