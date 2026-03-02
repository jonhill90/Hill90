-- Tool presets: named, reusable tool configurations for agents
-- Platform presets are immutable seed data. Admin-created presets can be modified.

CREATE TABLE IF NOT EXISTS tool_presets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    tools_config JSONB NOT NULL,
    is_platform BOOLEAN DEFAULT false,
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- FK on agents table: optional preset reference
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tool_preset_id UUID REFERENCES tool_presets(id);

-- Seed platform presets
INSERT INTO tool_presets (name, description, tools_config, is_platform) VALUES
(
  'Minimal',
  'Health monitoring only. No shell or filesystem access.',
  '{"shell":{"enabled":false,"allowed_binaries":[],"denied_patterns":[],"max_timeout":300},"filesystem":{"enabled":false,"read_only":false,"allowed_paths":["/workspace"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  true
),
(
  'Developer',
  'Full dev environment: bash, git, make, curl, jq. Read-write workspace and data.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash","git","make","curl","jq"],"denied_patterns":["rm -rf /",":(){ :|:& };:"],"max_timeout":300},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  true
),
(
  'Research',
  'Read-only with networking tools. Can fetch data but cannot modify filesystem.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash","curl","wget","jq"],"denied_patterns":["rm ","mv ","dd ","mkfs","> /",">> /"],"max_timeout":120},"filesystem":{"enabled":true,"read_only":true,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  true
),
(
  'Operator',
  'All pre-installed tools including rsync and ssh. Extended timeout for operations.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash","git","curl","wget","jq","rsync","ssh","make","vim"],"denied_patterns":["rm -rf /",":(){ :|:& };:"],"max_timeout":600},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data","/var/log/agentbox"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  true
)
ON CONFLICT (name) DO NOTHING;
