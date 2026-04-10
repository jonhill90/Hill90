-- Add schedule columns to agents table for auto-start cron scheduling.
-- Referenced by PUT /agents/:id/schedule and GET /agents/:id responses.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS schedule_cron VARCHAR(128);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN NOT NULL DEFAULT false;
