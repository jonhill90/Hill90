-- Migration 011: Add model_aliases JSONB column to model_policies.
--
-- Aliases let admins define semantic model names ("fast" -> "gpt-4o-mini")
-- so delegation and policy can be expressed in terms of capabilities.
-- Alias resolution is single-pass, policy-scoped, no recursion.

ALTER TABLE model_policies ADD COLUMN model_aliases JSONB DEFAULT '{}'::jsonb;

-- Seed default aliases on the 'default' policy
UPDATE model_policies
SET model_aliases = '{"fast": "gpt-4o-mini", "smart": "gpt-4o", "embed": "text-embedding-3-small"}'::jsonb
WHERE name = 'default';
