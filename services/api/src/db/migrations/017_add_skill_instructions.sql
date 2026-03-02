-- Migration 017: Add instructions_md to tool_presets for Skills Phase 1
-- instructions_md provides behavioral guidance for agents using a skill.
-- Split-update contract: tools_config is resolve-on-save (copied to agent at assignment),
-- instructions_md is fresh-at-start (fetched from skill at agent start time).

ALTER TABLE tool_presets ADD COLUMN IF NOT EXISTS instructions_md TEXT DEFAULT '';

-- Update platform seeds with meaningful instructions
UPDATE tool_presets SET instructions_md = 'You have no shell or filesystem access. You can only monitor your own resource usage via the health endpoint. Do not attempt to execute commands or read/write files — those tools are not available to you.'
WHERE name = 'Minimal' AND is_platform = true;

UPDATE tool_presets SET instructions_md = 'You have full developer access with bash, git, make, curl, and jq available. Use /workspace as your primary working directory and /data for persistent storage. You can read and write files in both locations. Avoid modifying system files outside your allowed paths.'
WHERE name = 'Developer' AND is_platform = true;

UPDATE tool_presets SET instructions_md = 'You have read-only filesystem access and networking tools (curl, wget, jq). You can fetch and analyze data but cannot modify files on disk. Use /workspace and /data for reading source material. Shell commands that modify the filesystem (rm, mv, dd, mkfs) are blocked.'
WHERE name = 'Research' AND is_platform = true;

UPDATE tool_presets SET instructions_md = 'You have full operator access including bash, git, curl, wget, jq, rsync, ssh, make, and vim. Extended timeout of 600 seconds is available for long-running operations. You can access /workspace, /data, and /var/log/agentbox. Use rsync and ssh for remote operations when needed.'
WHERE name = 'Operator' AND is_platform = true;
