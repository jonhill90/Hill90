-- Migration 043: Add 'thinking' status for tool-loop progress callbacks
--
-- The agentbox tool-calling loop sends intermediate 'thinking' callbacks
-- while executing tool calls. These update the message content and advance
-- the SSE sequence so the UI can show progress, but don't transition to
-- a terminal state.

ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_status_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_status_check
  CHECK (status IN ('pending', 'thinking', 'complete', 'error'));
