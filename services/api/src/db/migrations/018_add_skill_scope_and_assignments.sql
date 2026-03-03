-- Add scope column to tool_presets and create agent_skills join table
-- Slice 1 of Skills Architecture Reset: purely additive, no drops or renames

-- Add scope to tool_presets (all existing rows default to container_local)
ALTER TABLE tool_presets ADD COLUMN IF NOT EXISTS scope VARCHAR(32)
    NOT NULL DEFAULT 'container_local';

-- CHECK constraint for valid scope values (idempotent via NOT VALID + IF NOT EXISTS pattern)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_skill_scope'
    ) THEN
        ALTER TABLE tool_presets ADD CONSTRAINT chk_skill_scope
            CHECK (scope IN ('container_local', 'host_docker', 'vps_system'));
    END IF;
END $$;

-- M:N join table for agent-skill assignments
CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES tool_presets(id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    assigned_by VARCHAR(255),
    PRIMARY KEY (agent_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skill_id);
