-- Register tmux as a platform tool and skill (AI-199).
-- tmux is already installed in the agentbox image (builtin).
-- The tool definition (TMUX_TOOL) already exists in agentbox/app/tools.py.

-- 1. Seed tmux as a platform tool
INSERT INTO tools (name, description, install_method, install_ref, is_platform)
VALUES ('tmux', 'Terminal multiplexer — session management, window splitting, pane control', 'builtin', '', true)
ON CONFLICT (name) DO NOTHING;

-- 2. Seed the Tmux skill
INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform)
VALUES (
  'Tmux',
  'Terminal session management with tmux — create windows, split panes, run parallel tasks.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash","tmux"],"denied_patterns":["rm -rf /"],"max_timeout":300},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  E'Manage terminal sessions with tmux.\n- Create named windows for different tasks\n- Split panes horizontally (h) or vertically (v)\n- Send commands to specific panes with send_keys\n- List windows to track running processes\n- Use for parallel task execution (build in one pane, test in another)',
  'container_local',
  true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  tools_config = EXCLUDED.tools_config,
  instructions_md = EXCLUDED.instructions_md,
  scope = EXCLUDED.scope,
  is_platform = true;

-- 3. Wire skill_tools mappings
DELETE FROM skill_tools st
USING skills s
WHERE st.skill_id = s.id
  AND s.name = 'Tmux'
  AND s.is_platform = true;

INSERT INTO skill_tools (skill_id, tool_id)
SELECT s.id, t.id
FROM (VALUES
  ('Tmux', 'tmux'), ('Tmux', 'bash')
) AS mappings(skill_name, tool_name)
JOIN skills s ON s.name = mappings.skill_name
JOIN tools t ON t.name = mappings.tool_name
ON CONFLICT DO NOTHING;
