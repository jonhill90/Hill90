-- Fix binary tool names that were renamed via UI to include spaces.
-- The tool name is used as the binary filename in /data/tools/bin/{name},
-- as the lookup key for DEFAULT_BINARY_VERSIONS and BINARY_PATH_OVERRIDES,
-- and in env var construction (HILL90_{NAME}_VERSION).
-- Spaces in tool names break all three.

UPDATE tools SET name = 'gh' WHERE name = 'Github CLI';
UPDATE tools SET name = 'docker' WHERE name = 'Docker CLI';
