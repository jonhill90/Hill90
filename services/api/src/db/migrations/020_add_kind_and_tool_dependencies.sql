-- Concept split: distinguish skills (capabilities) from profiles (sandbox presets)
-- and add tool_dependencies for skills to declare binary requirements.

-- kind: 'skill' (default for new entries) or 'profile' (sandbox environment preset)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS kind VARCHAR(16)
    NOT NULL DEFAULT 'skill';

-- CHECK constraint for valid kind values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_skill_kind'
    ) THEN
        ALTER TABLE skills ADD CONSTRAINT chk_skill_kind
            CHECK (kind IN ('skill', 'profile'));
    END IF;
END $$;

-- tool_dependencies: JSONB array of binary names a skill requires
-- Profiles must have [] (enforced in application code, not DB)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS tool_dependencies JSONB
    DEFAULT '[]'::jsonb;

-- Reclassify existing platform seeds as profiles
UPDATE skills SET kind = 'profile'
    WHERE name IN ('Minimal', 'Developer', 'Research', 'Operator')
    AND is_platform = true;
