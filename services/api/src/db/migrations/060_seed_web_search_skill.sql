-- Seed the Web Search skill and tavily tool for agent web search (AI-254)

-- 1. Seed tavily as a platform tool
INSERT INTO tools (name, description, install_method, install_ref, is_platform)
VALUES ('tavily', 'Web search via Tavily API', 'builtin', '', true)
ON CONFLICT (name) DO NOTHING;

-- 2. Seed the Web Search skill
INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform)
VALUES (
  'Web Search',
  'Search the web for current information using Tavily.',
  '{"shell":{"enabled":true},"filesystem":{"enabled":true,"read_only":true}}',
  E'Search the web for real-time information.\n\n- Use the web_search tool with a clear, specific query\n- Results include title, URL, content snippet, and relevance score\n- Use for current events, documentation lookups, or any information not in the knowledge base\n- Prefer specific queries over broad ones for better results',
  'container_local',
  true
)
ON CONFLICT DO NOTHING;

-- 3. Wire skill_tools
INSERT INTO skill_tools (skill_id, tool_id)
SELECT s.id, t.id FROM skills s, tools t
WHERE s.name = 'Web Search' AND t.name = 'tavily'
ON CONFLICT DO NOTHING;
