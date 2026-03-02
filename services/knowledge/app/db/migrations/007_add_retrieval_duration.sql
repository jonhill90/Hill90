-- Add duration_ms to shared_retrievals for search latency tracking
ALTER TABLE shared_retrievals ADD COLUMN IF NOT EXISTS duration_ms INTEGER DEFAULT NULL;
