-- Phase 6D: Normalize seeded skill dependency mappings.
-- Baseline shell utilities (bash/curl/jq/vim/etc.) are runtime defaults, not skill-specific dependencies.
-- Skill dependencies should only declare capability-specific tools that may need explicit install/provisioning.

-- 1) Clear existing dependency mappings for platform-seeded skills.
DELETE FROM skill_tools st
USING skills s
WHERE st.skill_id = s.id
  AND s.is_platform = true
  AND s.name IN (
    'Claude Code',
    'Codex',
    'Hostinger',
    'VPS Administration',
    'GitHub',
    'Docker'
  );

-- 2) Re-add only non-baseline dependency mappings.
-- GitHub skill depends on GitHub CLI.
-- Docker skill depends on Docker CLI.
INSERT INTO skill_tools (skill_id, tool_id)
SELECT s.id, t.id
FROM (
  VALUES
    ('GitHub', 'gh'),
    ('Docker', 'docker')
) AS desired(skill_name, tool_name)
JOIN skills s ON s.name = desired.skill_name
JOIN tools t ON t.name = desired.tool_name
ON CONFLICT (skill_id, tool_id) DO NOTHING;
