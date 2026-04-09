-- Register Playwright chromium as a platform tool and Browser as a skill (AI-177).
-- Chromium is pre-installed in the agentbox image via `playwright install chromium --with-deps`.
-- The tool definition (BROWSER_TOOL) is in agentbox/app/tools.py.

-- 1. Seed playwright as a platform tool (builtin — pre-installed in image)
INSERT INTO tools (name, description, install_method, install_ref, is_platform)
VALUES ('playwright', 'Headless Chromium browser automation via Playwright', 'builtin', '', true)
ON CONFLICT (name) DO NOTHING;

-- 2. Seed the Browser skill
INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform)
VALUES (
  'Browser',
  'Headless browser automation — navigate pages, take screenshots, click elements, extract text.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash"],"denied_patterns":["rm -rf /"],"max_timeout":60},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  E'Automate a headless Chromium browser.\n- navigate: go to a URL and get page title/status\n- screenshot: capture the page to /workspace/screenshots/\n- click: click an element by CSS selector\n- get_text: extract visible text from a selector (default: body)\n- evaluate: run JavaScript in the page context\n\nScreenshots are saved to /workspace/screenshots/ with timestamp filenames.',
  'host_docker',
  true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  scope = EXCLUDED.scope,
  tools_config = EXCLUDED.tools_config,
  instructions_md = EXCLUDED.instructions_md,
  scope = EXCLUDED.scope,
  is_platform = true;

-- 3. Wire skill_tools mappings
DELETE FROM skill_tools st
USING skills s
WHERE st.skill_id = s.id
  AND s.name = 'Browser'
  AND s.is_platform = true;

INSERT INTO skill_tools (skill_id, tool_id)
SELECT s.id, t.id
FROM (VALUES
  ('Browser', 'playwright'), ('Browser', 'bash')
) AS mappings(skill_name, tool_name)
JOIN skills s ON s.name = mappings.skill_name
JOIN tools t ON t.name = mappings.tool_name
ON CONFLICT DO NOTHING;
