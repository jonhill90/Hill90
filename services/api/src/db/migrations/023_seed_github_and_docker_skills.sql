-- Phase 6C: add concrete GitHub and Docker capability skills.

INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform)
VALUES
(
  'GitHub',
  'Work with repositories, pull requests, and releases using GitHub CLI.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash","git","gh","curl","jq"],"denied_patterns":["rm -rf /"],"max_timeout":300},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  E'Use GitHub workflows from inside the agent container.\n- clone, branch, commit, push\n- create and review pull requests\n- inspect and rerun workflow checks\n- use least-privilege credentials for repository operations',
  'container_local',
  true
),
(
  'Docker',
  'Operate Docker on the host through Docker CLI and daemon access.',
  '{"shell":{"enabled":true,"allowed_binaries":["bash","docker","curl","jq"],"denied_patterns":["rm -rf /"],"max_timeout":600},"filesystem":{"enabled":true,"read_only":false,"allowed_paths":["/workspace","/data"],"denied_paths":["/etc/shadow","/etc/passwd","/root"]},"health":{"enabled":true}}',
  E'Operate Docker workloads with host-level access.\n- inspect containers, images, volumes, and networks\n- start, stop, restart, and remove containers\n- troubleshoot runtime failures and logs\n- treat as elevated capability requiring admin assignment',
  'host_docker',
  true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  tools_config = EXCLUDED.tools_config,
  instructions_md = EXCLUDED.instructions_md,
  scope = EXCLUDED.scope,
  is_platform = true;

-- Ensure mappings are canonical for seeded skills.
DELETE FROM skill_tools st
USING skills s
WHERE st.skill_id = s.id
  AND s.name IN ('GitHub', 'Docker')
  AND s.is_platform = true;

INSERT INTO skill_tools (skill_id, tool_id)
SELECT s.id, t.id
FROM (VALUES
  ('GitHub', 'gh'), ('GitHub', 'git'), ('GitHub', 'bash'), ('GitHub', 'curl'), ('GitHub', 'jq'),
  ('Docker', 'docker'), ('Docker', 'bash'), ('Docker', 'curl'), ('Docker', 'jq')
) AS mappings(skill_name, tool_name)
JOIN skills s ON s.name = mappings.skill_name
JOIN tools t ON t.name = mappings.tool_name
ON CONFLICT DO NOTHING;
