-- Phase 6A: Remove profile compromise, introduce Tools with install metadata.

-- 1. Create tools table
CREATE TABLE IF NOT EXISTS tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(64) NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    install_method VARCHAR(16) NOT NULL DEFAULT 'builtin',
    install_ref TEXT DEFAULT '',
    is_platform BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Seed platform tools (install_method reflects actual image state)
INSERT INTO tools (name, description, install_method, install_ref, is_platform) VALUES
('bash', 'Bourne-Again Shell', 'builtin', '', true),
('git', 'Distributed version control', 'builtin', '', true),
('make', 'Build automation tool', 'builtin', '', true),
('curl', 'HTTP client', 'builtin', '', true),
('wget', 'HTTP/FTP downloader', 'builtin', '', true),
('jq', 'JSON processor', 'builtin', '', true),
('rsync', 'Remote sync', 'builtin', '', true),
('ssh', 'Secure shell client', 'builtin', '', true),
('vim', 'Text editor', 'builtin', '', true),
('python3', 'Python interpreter', 'builtin', '', true),
('gh', 'GitHub CLI', 'binary', 'https://github.com/cli/cli/releases/download/v{version}/gh_{version}_linux_amd64.tar.gz', true),
('docker', 'Docker CLI', 'binary', 'https://download.docker.com/linux/static/stable/x86_64/docker-{version}.tgz', true)
ON CONFLICT (name) DO NOTHING;

-- 3. Create skill_tools join table
CREATE TABLE IF NOT EXISTS skill_tools (
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    PRIMARY KEY (skill_id, tool_id)
);

-- 4. Migrate tool_dependencies string arrays to skill_tools references
INSERT INTO skill_tools (skill_id, tool_id)
SELECT s.id, t.id
FROM skills s,
     jsonb_array_elements_text(s.tool_dependencies) AS dep_name
     JOIN tools t ON t.name = dep_name
WHERE s.tool_dependencies IS NOT NULL
  AND s.tool_dependencies != '[]'::jsonb
  AND s.kind = 'skill'
ON CONFLICT DO NOTHING;

-- 5. Add sandbox_profile to agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_profile VARCHAR(32);

-- 6. Migrate profile assignments: set sandbox_profile on agents that reference profiles
UPDATE agents a SET sandbox_profile = LOWER(s.name)
FROM agent_skills asks
JOIN skills s ON s.id = asks.skill_id
WHERE asks.agent_id = a.id
  AND s.kind = 'profile'
  AND s.is_platform = true;

-- 7. Remove profile assignments from agent_skills
DELETE FROM agent_skills asks
USING skills s
WHERE asks.skill_id = s.id
  AND s.kind = 'profile';

-- 8. Delete profile rows from skills
DELETE FROM skills WHERE kind = 'profile';

-- 9. Drop kind column and constraint
ALTER TABLE skills DROP CONSTRAINT IF EXISTS chk_skill_kind;
ALTER TABLE skills DROP COLUMN IF EXISTS kind;

-- 10. Drop tool_dependencies column (data migrated to skill_tools)
ALTER TABLE skills DROP COLUMN IF EXISTS tool_dependencies;

-- 11. Seed example capability skills (only skills whose every tool is builtin)
-- GitHub and Docker are deferred to Phase 6B (depend on non-builtin tools: gh, docker)
WITH new_skills AS (
    INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform)
    VALUES
    (
      'Claude Code',
      'AI-assisted software development workflow using Claude.',
      '{"shell":{"enabled":true,"allowed_binaries":["bash","git","curl","jq","python3","make"],"denied_patterns":["rm -rf /"],"max_timeout":300},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
      E'AI-assisted software development workflow.\n- Write, review, and refactor code in /workspace\n- Use git for version control\n- Run tests and validate changes\n- Model access provided via model router JWT',
      'container_local',
      true
    ),
    (
      'Codex',
      'AI-assisted software development using OpenAI Codex.',
      '{"shell":{"enabled":true,"allowed_binaries":["bash","git","curl","jq","python3","make"],"denied_patterns":["rm -rf /"],"max_timeout":300},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
      E'AI-assisted software development using OpenAI tools.\n- Write, review, and refactor code in /workspace\n- Use git for version control\n- Run tests and validate changes\n- Model access provided via model router JWT',
      'container_local',
      true
    ),
    (
      'Hostinger',
      'Hostinger VPS and DNS management via API and SSH.',
      '{"shell":{"enabled":true,"allowed_binaries":["bash","curl","ssh","python3","jq"],"denied_patterns":["rm -rf /"],"max_timeout":600},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
      E'Manage Hostinger VPS and DNS infrastructure.\n- API-based VPS operations (start, stop, rebuild)\n- DNS record management for hill90.com\n- SSH-based remote administration\n- Authenticate using Hostinger API token',
      'vps_system',
      true
    ),
    (
      'VPS Administration',
      'System-level VPS administration and operations.',
      '{"shell":{"enabled":true,"allowed_binaries":["bash","ssh","rsync","curl","wget","jq","vim","make"],"denied_patterns":["rm -rf /"],"max_timeout":600},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data","/var/log/agentbox"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
      E'System-level VPS administration and operations.\n- SSH to remote hosts for management\n- File synchronization with rsync\n- Service management and monitoring\n- Log analysis and troubleshooting',
      'vps_system',
      true
    )
    ON CONFLICT (name) DO NOTHING
    RETURNING id, name
)
INSERT INTO skill_tools (skill_id, tool_id)
SELECT ns.id, t.id
FROM (VALUES
    ('Claude Code', 'git'), ('Claude Code', 'bash'), ('Claude Code', 'curl'),
    ('Claude Code', 'jq'), ('Claude Code', 'python3'), ('Claude Code', 'make'),
    ('Codex', 'git'), ('Codex', 'bash'), ('Codex', 'curl'),
    ('Codex', 'jq'), ('Codex', 'python3'), ('Codex', 'make'),
    ('Hostinger', 'curl'), ('Hostinger', 'ssh'), ('Hostinger', 'python3'),
    ('Hostinger', 'jq'), ('Hostinger', 'bash'),
    ('VPS Administration', 'ssh'), ('VPS Administration', 'rsync'),
    ('VPS Administration', 'bash'), ('VPS Administration', 'curl'),
    ('VPS Administration', 'wget'), ('VPS Administration', 'jq'),
    ('VPS Administration', 'vim'), ('VPS Administration', 'make')
) AS mappings(skill_name, tool_name)
JOIN new_skills ns ON ns.name = mappings.skill_name
JOIN tools t ON t.name = mappings.tool_name
ON CONFLICT DO NOTHING;
