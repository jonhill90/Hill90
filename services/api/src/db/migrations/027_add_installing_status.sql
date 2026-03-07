-- Phase 6B: Widen agent_tool_installs status to include 'installing'.
-- Existing rows (pending/installed/failed) remain valid.
-- Uses deterministic constraint name for idempotent DROP + re-add.
--
-- Rollback: UPDATE agent_tool_installs SET status = 'pending' WHERE status = 'installing';
--           then DROP CONSTRAINT IF EXISTS + re-add narrower CHECK.

ALTER TABLE agent_tool_installs
  DROP CONSTRAINT IF EXISTS agent_tool_installs_status_check;

ALTER TABLE agent_tool_installs
  ADD CONSTRAINT agent_tool_installs_status_check
  CHECK (status IN ('pending', 'installing', 'installed', 'failed'));
