-- Add autonomy_level column to agents table (AI-227).
-- Valid values: 'ask_before_acting', 'act_within_scope', 'full_autonomy'.
-- Default: 'act_within_scope' — agent acts freely within its skill/tool permissions.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS autonomy_level VARCHAR(32) NOT NULL DEFAULT 'act_within_scope';
