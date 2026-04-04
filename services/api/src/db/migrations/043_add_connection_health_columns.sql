-- Add health monitoring columns to provider_connections
ALTER TABLE provider_connections ADD COLUMN last_validated_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE provider_connections ADD COLUMN last_validation_error TEXT DEFAULT NULL;
ALTER TABLE provider_connections ADD COLUMN validation_latency_ms INTEGER DEFAULT NULL;
