-- Migration 019: Rename tool_presets to skills and migrate agent assignments
-- Phase 2 of Skills Architecture Reset

-- Rename the table
ALTER TABLE tool_presets RENAME TO skills;

-- Rename the CHECK constraint
ALTER TABLE skills RENAME CONSTRAINT chk_skill_scope TO chk_scope;

-- Migrate tool_preset_id data into agent_skills join table
INSERT INTO agent_skills (agent_id, skill_id, assigned_by)
SELECT id, tool_preset_id, created_by
FROM agents
WHERE tool_preset_id IS NOT NULL
ON CONFLICT (agent_id, skill_id) DO NOTHING;

-- Drop the old FK column (cascade drops the FK constraint too)
ALTER TABLE agents DROP COLUMN IF EXISTS tool_preset_id;
