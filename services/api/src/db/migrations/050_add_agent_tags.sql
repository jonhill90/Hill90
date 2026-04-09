-- Add tags column to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agents_tags ON agents USING GIN (tags);
