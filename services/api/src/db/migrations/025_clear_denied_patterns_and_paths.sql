-- RBAC-first cleanup: remove command/path deny-list defaults from persisted configs.
-- Elevated capability boundaries are enforced via skill scopes and RBAC, not deny patterns.

UPDATE skills
SET tools_config = jsonb_set(
  jsonb_set(COALESCE(tools_config, '{}'::jsonb), '{shell,denied_patterns}', '[]'::jsonb, true),
  '{filesystem,denied_paths}',
  '[]'::jsonb,
  true
)
WHERE tools_config IS NOT NULL;

UPDATE agents
SET tools_config = jsonb_set(
  jsonb_set(COALESCE(tools_config, '{}'::jsonb), '{shell,denied_patterns}', '[]'::jsonb, true),
  '{filesystem,denied_paths}',
  '[]'::jsonb,
  true
)
WHERE tools_config IS NOT NULL;
