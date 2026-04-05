-- Migration 044: Mark stale 'token expired' error messages (AI-167)
--
-- Old chat messages with 'token expired' errors are noise — the token was
-- refreshed and the agent recovered, but the error messages remain visible
-- in thread history. This migration marks them as stale so the UI can
-- filter or dim them.

-- Widen status enum to include 'stale'
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_status_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_status_check
  CHECK (status IN ('pending', 'thinking', 'complete', 'error', 'stale'));

-- Mark existing token-expired error messages as stale
UPDATE chat_messages
   SET status = 'stale'
 WHERE status = 'error'
   AND error_message ILIKE '%token expired%';
