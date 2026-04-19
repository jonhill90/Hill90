-- Add webhook trigger support to workflows.
-- Each workflow can have an inbound webhook URL that triggers it.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(32) NOT NULL DEFAULT 'cron';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS webhook_token VARCHAR(64);
ALTER TABLE workflows ALTER COLUMN schedule_cron DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_webhook_token ON workflows(webhook_token) WHERE webhook_token IS NOT NULL;
